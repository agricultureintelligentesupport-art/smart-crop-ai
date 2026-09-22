import { expect, test } from "@playwright/test";
import { ASSISTANT } from "../src/lib/assistant/copy";

const copy = ASSISTANT.ar;

// Use the app's supported on-device session; no external auth/provider calls.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("smart-crop.lang.v1", "ar");
    localStorage.setItem(
      "smart-crop.profile.v1",
      JSON.stringify({
        uid: "local_clarification_test",
        method: "email",
        displayName: "Test farmer",
        role: "farmer",
        wilayaCode: "07",
        updatedAt: Date.now(),
      }),
    );
  });
});

/** The raw MobileNetV2 vector the first pass hands back with its question. */
const PREDICTIONS = [
  { label: "Potato___Late_blight", score: 0.45 },
  { label: "Tomato___Early_blight", score: 0.15 },
  { label: "Grape___Black_rot", score: 0.1 },
];

const QUESTIONS = [
  {
    id: "crop",
    question: "ما هو نوع هذا النبات؟",
    options: ["طماطم", "بطاطس", "عنب", "تفاح", "خوخ", "غير ذلك"],
  },
];

const FILTERED_REPORT = {
  applied: true,
  answer: "طماطم",
  cropKey: "tomato",
  crop: "طماطم",
  matchedClasses: 1,
  droppedClasses: 2,
  totalClasses: 3,
  topLabelBefore: "Potato___Late_blight",
  topScoreBefore: 0.45,
  topLabelAfter: "Tomato___Early_blight",
  topScoreAfter: 1,
  changedTop: true,
};

test("low confidence asks for the crop, then diagnoses from the masked vector", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/assistant", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);

    // FIRST PASS — MobileNetV2's Top-1 is only 45%: ask, do not diagnose.
    if (!body.userAnswers) {
      await route.fulfill({
        json: {
          reply: "نموذج الرؤية غير واثق بما يكفي (أعلى احتمال 45% فقط).\nحدّد نوع النبات:",
          diagnosis: null,
          source: "clarification",
          requiresClarification: true,
          questions: QUESTIONS,
          predictions: PREDICTIONS,
        },
      });
      return;
    }

    // SECOND PASS — the answer came back with the echoed logit vector.
    await route.fulfill({
      json: {
        reply: "## 🔬 التشخيص\n- الإصابة: **الطماطم — اللفحة المبكرة** (Tomato___Early_blight) بثقة 100%.",
        diagnosis: {
          label: "Tomato___Early_blight",
          labelAr: "الطماطم — اللفحة المبكرة",
          cropAr: "الطماطم",
          diseaseAr: "اللفحة المبكرة",
          healthy: false,
          confidence: 1,
          model: "linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification",
          candidates: [{ label: "Tomato___Early_blight", score: 1 }],
          symptoms: ["بقع بنية بحلقات متداخلة"],
          filtered: true,
        },
        source: "hybrid",
        filtered: FILTERED_REPORT,
      },
    });
  });

  await page.goto("/assistant");
  await page.getByRole("textbox").fill("شخّص هذه الورقة");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();

  // The wizard renders the mandated question and the six crop options.
  await expect(page.getByText(copy.clarification.title, { exact: true })).toBeVisible();
  await expect(page.getByText("ما هو نوع هذا النبات؟", { exact: true })).toBeVisible();
  for (const option of QUESTIONS[0].options) {
    await expect(page.getByRole("radio", { name: option, exact: true })).toBeVisible();
  }
  // No diagnosis is claimed while the verdict is still a coin flip.
  await expect(page.getByText(copy.diagnosis.title, { exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(1);

  // Answer "طماطم" and submit → the request is replayed with the answers.
  await page.getByRole("radio", { name: "طماطم", exact: true }).check();
  await page.getByRole("button", { name: copy.clarification.submit, exact: true }).click();

  await expect(page.getByText(`${copy.clarification.answerPrefix}: طماطم`, { exact: true })).toBeVisible();
  await expect(page.getByText("الطماطم — اللفحة المبكرة", { exact: true })).toBeVisible();
  // The masking was transparent: 45% potato → 100% tomato.
  await expect(page.getByText(/45% → 100%/)).toBeVisible();

  expect(bodies).toHaveLength(2);
  expect(bodies[1].userAnswers).toEqual({ crop: "طماطم" });
  // The original MobileNetV2 logits travelled back, so the server masks the
  // very vector the farmer saw instead of classifying the photo again.
  expect(bodies[1].predictions).toEqual(PREDICTIONS);
  // Neither pass looks like a configuration or transport failure.
  await expect(page.getByRole("button", { name: copy.chat.retry })).toHaveCount(0);
  await expect(page.getByText(copy.chat.unavailable, { exact: true })).toHaveCount(0);
});

test("the wizard survives a second-pass failure: the retry replays the answers", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  let failNext = false;
  await page.route("**/api/assistant", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 502, json: { error: "AI service temporarily unavailable" } });
      return;
    }
    if (!body.userAnswers) {
      await route.fulfill({
        json: {
          reply: "نموذج الرؤية غير واثق بما يكفي.",
          diagnosis: null,
          source: "clarification",
          requiresClarification: true,
          questions: QUESTIONS,
          predictions: PREDICTIONS,
        },
      });
      return;
    }
    await route.fulfill({
      json: { reply: "تقرير اللفحة المبكرة.", diagnosis: null, source: "llm" },
    });
  });

  await page.goto("/assistant");
  await page.getByRole("textbox").fill("شخّص هذه الورقة");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText(copy.clarification.title, { exact: true })).toBeVisible();

  failNext = true;
  await page.getByRole("radio", { name: "بطاطس", exact: true }).check();
  await page.getByRole("button", { name: copy.clarification.submit, exact: true }).click();
  await expect(page.getByText(copy.chat.error, { exact: true })).toBeVisible();

  // The retry chip replays the SAME answered request, not the first pass.
  await page.getByRole("button", { name: copy.chat.retry }).click();
  await expect(page.getByText("تقرير اللفحة المبكرة.", { exact: true })).toBeVisible();

  const last = bodies.at(-1) as Record<string, unknown>;
  expect(last.userAnswers).toEqual({ crop: "بطاطس" });
  expect(last.predictions).toEqual(PREDICTIONS);
  // A transient failure never re-asks the questionnaire.
  await expect(page.getByRole("radio", { name: "طماطم", exact: true })).toHaveCount(0);
});
