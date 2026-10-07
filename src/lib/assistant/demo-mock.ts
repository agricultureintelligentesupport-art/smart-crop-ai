/**
 * PhytoScan AI — DEMO-ONLY canned replies (demo video / pitch recording).
 *
 * WHY THIS FILE EXISTS
 *   The recording of the demo must be fast, deterministic and completely
 *   immune to provider problems (API quotas, credits, rate limits, cold
 *   starts, network hiccups). This module holds the SCRIPTED answers of the
 *   demo: the route recognises the presenter's prompts and replies with the
 *   text below after a simulated 600 ms network round-trip, so every turn
 *   looks exactly like a real answer while NO provider call is ever made.
 *
 * HOW IT IS WIRED
 *   `src/app/api/assistant/route.ts` calls {@link getDemoMockResponse} at the
 *   very start of `POST`. A non-null string short-circuits the whole
 *   orchestrator (irrelevant for the demo: no keys, no quota, no latency) and
 *   a `null` return means "not a scripted turn" — the REAL pipeline then runs
 *   completely untouched, exactly as before this file existed.
 *
 * HOW TO TURN IT ON / OFF  (nothing else in the project changes)
 *   ON  · `DEMO_MOCK=1`   (also accepts true / on / yes / enabled;
 *                          `PHYTOSCAN_DEMO_MOCK` is honoured as an alias)
 *   OFF · unset or `DEMO_MOCK=0` — the DEFAULT, which is what every normal
 *         deployment (Vercel / production / the unit test suite) sees, so the
 *         real provider pipeline stays in charge unless the demo asks
 *         otherwise.
 *   Set it in `.env.local` for a local/preview recording session, and remove
 *   it (or set 0) before shipping. Every mocked turn is logged loudly on the
 *   server as `[Demo Mock]` and the response carries a `warnings` note, so a
 *   mock answer is never mistakable for a real model answer.
 *
 * Kept dependency-free so it is safe to import from the server bundle.
 */

/** One incoming turn, mirroring the route's request history shape. */
export interface DemoMockMessage {
  role: string;
  content: string;
  /** Raw base64 (no data-URL prefix) — kept optional for compatibility. */
  image?: string;
  /** Legacy alias carried by older UI turns. */
  imageUrl?: string;
}

/**
 * Simulated network round-trip. 600 ms sits in the sweet spot for a demo:
 * fast enough to keep the recording tight, slow enough that the thinking
 * indicator is visible and the answer does not look suspiciously canned.
 */
const DEMO_MOCK_DELAY_MS = 600;

/**
 * Sentence that identifies the FIRST scripted photo answer. Because the UI
 * strips photos but keeps the assistant's text when a conversation is sent
 * back as `history`, seeing this line in an earlier assistant turn is how the
 * mock knows the presenter already showed the first leaf — so the next photo
 * gets the SECOND scripted diagnosis (Dieback), in the same order as the
 * demo script.
 */
const FIRST_IMAGE_REPLY_MARKER = "احتراق حواف الأوراق (Leaf Scorch)";

/** Explicit opt-in values for `DEMO_MOCK`. */
const TRUTHY = new Set(["1", "true", "on", "yes", "y", "enabled"]);

/**
 * Is the demo mock enabled for this process?
 *
 * OPT-IN by design: an unset/blank/unknown value keeps the file inert, so the
 * production orchestrator and the test suite behave exactly as before. Reads
 * `process.env` on every call (never cached at module load) so a flag added to
 * `.env.local` is picked up by the next request without a rebuild.
 */
export function isDemoMockEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.DEMO_MOCK ?? env.PHYTOSCAN_DEMO_MOCK ?? "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

/**
 * Light Arabic/French normalisation used ONLY for keyword matching, so the
 * presenter can type naturally ("لم أفهم", "أهلاً", "بالفرنسية"…) without the
 * mock missing the turn: tashkeel and tatweel are dropped, the alef/hamza and
 * ة/ى forms are unified, and whitespace is collapsed. The REPLY text below is
 * never normalised — it is returned byte-for-byte as scripted.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670]/g, "")
    .replace(/\u0640/g, "")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A")
    .replace(/\s+/g, " ")
    .trim();
}

/** Substring test where BOTH sides are normalised ("أهلاً" matches "أهلا"). */
function includesAny(text: string, keywords: readonly string[]): boolean {
  const haystack = normalize(text);
  return keywords.some((keyword) => haystack.includes(normalize(keyword)));
}

/* ------------------------------------------------------------------ */
/*  Scripted replies                                                   */
/* ------------------------------------------------------------------ */

/** 1 · الترحيب */
const GREETING_REPLY = `مرحباً بك! 👋

أنا هنا لمساعدتك في إدارة محاصيلك وصحة نباتاتك في الميدان الزراعي.

إذا كان لديك أي سؤال حول صحة النبات، التسميد، السقي، أو ظهور أعراض مرضية، فأخبرني بالتفصيل.

أو يمكنك إرسال صورة مباشرة للحالة لتشخيصها فوراً.`;

/** 2 · التعريف بالنفس */
const IDENTITY_REPLY = `أنا **PhytoScan AI** — مستشارك الزراعي الذكي المطور خصيصاً لدعم الفلاحين والمتعاملين الزراعيين في الجزائر.

• **مهامي الأساسية:**
• تشخيص أمراض النباتات والآفات فوراً من خلال تحليل الصور.
• تقديم خطط علاج وقاية مخصصة باستخدام المبيدات والممارسات المعتمدة محلياً.
• تقديم استشارات في الري، التسميد، وحماية المحاصيل بناءً على الظروف المناخية والتربة الجزائرية.`;

/** 3 · الشرح الإضافي (لم أفهم) */
const EXPLAIN_REPLY = `أفهمك، يُقصد باحتراق الحواف أن الأوراق الفتية يفوق فيها معدل تبخر الماء قدرة الجذور على الامتصاص، مما يسبب جفاف الخلايا الطرفية وتلفها.

**الخطوات العملية التوضيحية:**

• **السقي:** اسقِ النبات في الصباح الباكر فقط لضمان توفر الرطوبة قبل اشتداد الحرارة.
• **التقليم:** قم بقص الحواف الجافة والميتة بمقلم معقم لتشجيع ظهور نموات جديدة.
• **الرش:** استعمل المحلول المذكور لحماية الأوراق المتبقية من أي إصابات فطرية ثانوية.`;

/** 4 · التحويل للفرنسية */
const FRENCH_REPLY = `.Oui, bien sûr

La cause de ce dessèchement est une infection fongique vasculaire, souvent déclenchée par des lésions sur le bois ou un stress hydrique. Cela provoque le dessèchement progressif des branches et la mort des tissus.

**: Pour traiter**

• Appliquez du **copper oxychloride 50 %** (ex. : Skor ou Mancozeb 80 %) à la dose de 1,5 g par litre d'eau.
• Taillez les parties sèches et désinfectez les outils.

**: Prévention**

• Évitez les blessures mécaniques et contrôlez l'arrosage.`;

/** 5 · تحليل الصور — الصورة الأولى */
const FIRST_IMAGE_REPLY = `[ 🔍 لم يُعثر على ورقة واحدة — شُخِّصت الصورة كاملة. ]

🧪 نتيجة تشخيص الصورة

### **احتراق حواف الأوراق (Leaf Scorch)**

**نسبة الثقة:** \`88% · ثقة مرتفعة\`

احتراق حواف الأوراق يُعد عارضاً ناتجاً عن الإجهاد الحراري والتذبذب في نظام السقي، وتظهر بقع جافة مائلة للابيضاض والاصفرار على حواف الأوراق الحديثة والسطحية للنبات. هذه الحالة تُعرف بـ "الجفاف الأنسجي السطحي" وتحدث نتيجة عدم انتظام رطوبة التربة مع التعرض لأشعة الشمس.

**خطة علاج ووقاية:**

\`1\` **اسم المنتج:** أكسي كلورور النحاس 50% (أو مركب سماد ورقي غني بالبوتاسيوم)

• **الجرعة:** 1.5 غرام لكل لتر ماء

• **الطريقة:** رش ورقي على الأجزاء المتضررة في الصباح الباكر، يُكرر كل 10 أيام لـ 3 رشات

• **البدائل:** إذا لم يتوفر، استخدم مبيد مانكوزيب 80% كبديل وقائي

• **ملاحظة:** تجنب الري المفرط في أوقات الظهيرة وتقليم الأطراف المحترقة جداً

\`1\` **الوقاية:**

• تنظيم أوقات السقي، وتجنب تراكم الرطوبة أو الجفاف الشديد للتربة.`;

/** 5 · تحليل الصور — الصورة الثانية */
const SECOND_IMAGE_REPLY = `[ 🔍 لم يُعثر على ورقة واحدة — شُخِّصت الصورة كاملة. ]

🧪 نتيجة تشخيص الصورة

### **تيبس الأغصان والموت الخلفي (Dieback)**

**نسبة الثقة:** \`85% · ثقة مرتفعة\`

تيبس الأغصان يُعد إصابة وعائية تسبب جفافاً كاملاً للأفرع والحطب، وتظهر كأغصان عارية وميتة تتراجع فيها العصارة. هذه الحالة تُعرف بـ "موت الخشب الوعائي" وتنتج غالباً عن إصابات فطرية سابقة أو جروح ميكانيكية غير معالجة في الساق.

**خطة علاج ووقاية:**

\`1\` **اسم المنتج:** مانكوزيب 80% (أو مركب نحاسي مثل أوكسي كلورور النحاس 50%)

• **الجرعة:** 1.5 غرام لكل لتر ماء

• **الطريقة:** قص الأغصان الميتة حتى الخشب الحي، ثم رش النبات كلياً ومكان القص

• **البدائل:** استخدام الكلوروثالونيل 50% كبديل فعال

• **ملاحظة:** حرق الأغصان المقصوصة فوراً وتطهير أدوات التقليم بالكحول

\`1\` **الوقاية:**

• تجنب إحداث جروح في الساق والأغصان ومراقبة الأشجار بانتظام.`;

/* ------------------------------------------------------------------ */
/*  Matching                                                           */
/* ------------------------------------------------------------------ */

/**
 * Map the recognised demo turn to its scripted reply, or `null` when the turn
 * is NOT part of the demo script (the caller must then run the real pipeline).
 *
 * Priority follows the demo script order: greeting → self-introduction →
 * "explain more" → French → photo diagnosis (1st photo, then 2nd photo).
 */
function resolveScriptedReply(text: string, hasImage: boolean, totalImages: number): string | null {
  const normalized = normalize(text);

  // 1. الترحيب — the two substrings of the script, plus the exact bare
  // "سلام" and the very common "السلام عليكم" (accepted so a presenter who
  // opens with the traditional greeting is never dropped into the real
  // pipeline mid-recording).
  if (
    includesAny(text, ["مرحبا", "أهلا"]) ||
    normalized === normalize("سلام") ||
    normalized.startsWith(normalize("السلام عليكم")) ||
    normalized === normalize("سلام عليكم")
  ) {
    return GREETING_REPLY;
  }

  // 2. التعريف بالنفس
  if (includesAny(text, ["عرف بنفسك", "من أنت", "شكون انت"])) {
    return IDENTITY_REPLY;
  }

  // 3. الشرح الإضافي (لم أفهم)
  if (includesAny(text, ["اشرحلي", "لم افهم", "التفاصيل", "اشرح"])) {
    return EXPLAIN_REPLY;
  }

  // 4. التحويل للفرنسية
  if (includesAny(text, ["فرنسية", "français", "francais"])) {
    return FRENCH_REPLY;
  }

  // 5. تحليل الصور (حسب الترتيب: الصورة الأولى ثم الثانية)
  if (hasImage) {
    return totalImages <= 1 ? FIRST_IMAGE_REPLY : SECOND_IMAGE_REPLY;
  }

  return null;
}

/**
 * Count the photos in this conversation.
 *
 * `messages` carries the photos attached to the CURRENT turn (the UI doesn't
 * resend earlier base64 payloads). An earlier SCRIPTED photo answer
 * ({@link FIRST_IMAGE_REPLY_MARKER}) is therefore counted as one additional
 * photo already shown, which is what makes the second photo of the recording
 * return {@link SECOND_IMAGE_REPLY} instead of repeating the first one.
 */
function countImages(messages: readonly DemoMockMessage[]): number {
  const markerInAssistantTurns = messages.filter(
    (message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      normalize(message.content).includes(normalize(FIRST_IMAGE_REPLY_MARKER)),
  ).length;

  const attachedNow = messages.filter(
    (message) => message.role === "user" && Boolean(message.image || message.imageUrl),
  ).length;

  return attachedNow + markerInAssistantTurns;
}

/**
 * Build the message list the mock evaluates from a route request: the
 * conversation history followed by the current user turn (its photo included
 * as `image`, mirroring the request body).
 */
export function buildDemoMockMessages(
  message: string,
  imageData: string | undefined,
  history: ReadonlyArray<{ role: string; content: string }> = [],
): DemoMockMessage[] {
  return [
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    {
      role: "user",
      content: message,
      ...(imageData ? { image: imageData } : {}),
    },
  ];
}

/**
 * The route's entry point: returns the scripted reply for a demo turn, or
 * `null` when the turn is not part of the script (the real orchestrator then
 * runs untouched).
 *
 * The simulated 600 ms delay is applied ONLY when a match was found, so a
 * non-scripted turn never pays for it before reaching the real pipeline.
 */
export async function getDemoMockResponse(
  messages: Array<{ role: string; content: string; image?: string }>,
): Promise<string | null> {
  if (!messages || messages.length === 0) return null;

  const userMessages = messages.filter((message) => message.role === "user");
  const lastUserMsg = userMessages[userMessages.length - 1];
  if (!lastUserMsg) return null;

  const text = (lastUserMsg.content || "").trim().toLowerCase();
  const hasImage = Boolean(lastUserMsg.image || (lastUserMsg as { imageUrl?: string }).imageUrl);
  const totalImages = countImages(messages);

  const reply = resolveScriptedReply(
    // `text` is already lowercased; the Arabic normalisation inside
    // `includesAny` still applies (tashkeel/alef/ة-ى unification).
    text,
    hasImage,
    totalImages,
  );
  if (reply === null) return null;

  // Simulated network round-trip — keeps the demo pace natural.
  await new Promise((resolve) => setTimeout(resolve, DEMO_MOCK_DELAY_MS));
  return reply;
}
