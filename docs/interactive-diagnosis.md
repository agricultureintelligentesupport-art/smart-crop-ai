# Step 1.5 — Interactive diagnosis (MobileNetV2 logit masking + recalculation)

## Why

`linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification` is the
**strict diagnostic authority** of the pipeline: 38 PlantVillage classes, one
raw probability each. The LLM stages downstream may *format* its verdict —
they may never invent one.

But MobileNetV2 is **confidently wrong** more often than its softmax admits:
an 83% "Potato___Late_blight" on a tomato leaf is not a coin flip, yet it is a
wrong locked diagnosis — and it never reached the taxonomy filter, the only
mechanism that can drop impossible crops. A confident-looking guess wrapped in
a fluent Arabic report is worse than no answer at all, so the gate sits at
**90%**: below it the route **asks instead of guessing** — one question, one
answer, and the logit vector itself is re-scored against the farmer's crop.
The check is strict (`< 0.9`), so a Top-1 of exactly 90% still proceeds.

## The two passes

```
POST /api/assistant { message, image }
  │
  ├─ Step 0 detect + crop  →  Step 1 MobileNetV2 (FULL vector, 38 classes)
  │
  ├─ Top-1 ≥ 90%  →  normal hybrid path (Gemini formats the verdict)
  │
  └─ Top-1 < 90%  →  200 {
                       requiresClarification: true,
                       questions: [{
                         id: "crop",
                         question: "ما هو نوع هذا النبات؟",
                         options: ["طماطم","بطاطس","عنب","تفاح","خوخ","غير ذلك"],
                       }],
                       predictions: [ …raw MobileNetV2 vector… ],
                       source: "clarification",
                       diagnosis: null,
                     }                                  ← NO LLM is called

POST /api/assistant { message, image, userAnswers: { crop: "طماطم" },
                      predictions: [ …echoed vector, optional… ] }
  │
  ├─ applyTaxonomyFilter(vector, userAnswers)              ← src/lib/vision/taxonomyFilter.ts
  │    1. drop every class whose crop ≠ the answered crop
  │    2. Σ raw scores of the survivors
  │    3. each survivor: rawScore ÷ Σ            (recalculated probability)
  │    4. sort descending
  │
  ├─ masked Top-1  →  the diagnosis (`filtered` response field reports the math)
  └─ Gemini / HF LLM / built-in card  →  LOCKED FORMATTER mode
```

### The recalculation, concretely

| Class | Raw score | After masking "طماطم" |
| --- | --- | --- |
| `Potato___Late_blight` | 0.45 | dropped (wrong plant) |
| `Tomato___Early_blight` | 0.15 | **0.15 ÷ 0.15 = 1.00 (100%)** |
| `Grape___Black_rot` | 0.10 | dropped (wrong plant) |

The softmax mass the tomato class was competing against simply does not
belong to a tomato plant, so the surviving classes are renormalised to the
probability they actually compete for. When several classes of the same crop
survive, they share that mass (0.15 + 0.05 + 0.02 → 68% / 23% / 9%) and the
Top-1 stays the model's own ordering.

`DISEASE_TAXONOMY` is the source of truth: every one of the 38 classes → its
single possible crop (Arabic label + machine key) + a short Arabic symptom
fingerprint that is handed to the formatter so the report describes the
symptoms of *this* disease.

## Strict formatting (Gemini is a formatter)

After a masking pass the system instruction is the normal expert prompt plus
`buildLockedSystemPrompt(diagnosis)`:

```
You are a formatter. The system has diagnosed the plant with
<Tomato___Early_blight> (<الطماطم — اللفحة المبكرة>). You MUST NOT change this
diagnosis. Your ONLY job is to write a professional agricultural report in
Arabic explaining the visual symptoms, immediate treatment, and prevention for
this specific disease.
```

plus the Arabic rules that keep the standing anchors in force:

- `أنت مساعد زراعي خبير` — but here a formatter, not a diagnostician;
- `دون مقدمات أو إطالة` — start with the diagnosis;
- `باللغة العربية` — Arabic only;
- `عملي` — visible symptoms, immediate treatment (Algerian market products,
  dose + pre-harvest interval), then prevention.

The same system prompt and user turn are used by the Hugging Face fallback
chain, so a Stage-1 outage cannot un-lock the verdict either. The user turn
carries the filtered label, the recalculated percentage and the symptom
fingerprint — never the classes the mask removed.

## Edge cases

| Situation | Behaviour |
| --- | --- |
| `"غير ذلك"` / unrecognised answer | No masking; MobileNetV2's own ranking stands, no formatter lock, no warning. |
| Crop understood but no predicted class belongs to it | Masking would empty the vector → raw ranking stands + a `warnings[]` note (`تعذّرت التصفية…`). |
| Second pass without the echoed vector (or with a malformed one) | The image is re-classified; every echoed row must resolve to a taxonomy class with a finite score in [0,1] before it is trusted. |
| Vision outage on the second pass | Normal degradation: Fallback A (Gemini inspects the raw image) → HF LLM → built-in card. `/api/assistant` still never returns 500. |
| Masked Top-1 still < 45% (crop classes split evenly) | The verdict ships with its honest percentage and the direct card keeps the "أرسل صورة أوضح" note. |
| Top-1 between 60% and 90% (e.g. the 83% regressions) | Treated like any shaky verdict: the questionnaire runs, so the wrong-crop logits are masked away before the LLM sees anything. |
| Second pass (the questionnaire was already answered) | Never re-asks — the mask runs and the masked Top-1 is the verdict, whatever its recalculated value. |

## Frontend

`src/components/assistant/ClarificationWizard.tsx` renders inside the asking
bubble: one radiogroup (six ≥44 px cards), native radio semantics, keyboard
arrow navigation, RTL-aware, AR/FR copy (`ASSISTANT[lang].clarification`),
`prefers-reduced-motion` respected. Submitting freezes the wizard into a
receipt, echoes the choice as a user turn, and replays the original request
with `userAnswers` + the echoed logits. The second-pass reply shows a chip
with the recalculation (`🎯 … 45% → 100%`).

## Tests

- `test/unit/taxonomy-filter.unit.test.ts` — taxonomy integrity, answer
  resolution, masking/recalculation maths (including the 15%-behind-45%
  validation scenario), passthrough and robustness cases.
- `test/unit/assistant-interactive.unit.test.ts` — route contract for both
  passes: questionnaire instead of an LLM call, masked verdict + strict
  formatter anchors, echoed-vector reuse, re-classification fallback,
  `"غير ذلك"`, unmatched crop, direct-card survival.
- `e2e/assistant-clarification.spec.ts` — the wizard in the browser:
  question → answer → recalculated diagnosis, and the retry path.
