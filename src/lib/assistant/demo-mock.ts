/**
 * PhytoScan AI — DEMO-ONLY canned replies (demo video / pitch recording).
 *
 * WHY THIS FILE EXISTS
 *   The recording of the demo must be fast, deterministic and completely
 *   immune to provider problems (API quotas, credits, rate limits, cold
 *   starts, network hiccups). This module holds the SCRIPTED answers of the
 *   demo: the route recognises the presenter's prompts and replies with the
 *   text below after a simulated network round-trip — 600 ms for a text
 *   turn, a full 5 s for a photo turn (the beat a real vision diagnosis
 *   needs) — so every turn
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
 *   ON  · THE DEFAULT — no configuration at all. An unset/blank `DEMO_MOCK`
 *         means the demo is ON, which is what makes a deployed recording
 *         environment (Vercel has no `.env.local`) answer with the script
 *         instead of silently falling back to the old basic-mode reply.
 *   OFF · `DEMO_MOCK=0` (also false / off / no / disabled;
 *         `PHYTOSCAN_DEMO_MOCK` is honoured as an alias). Use it for
 *         production and for the automated test suite, which pin it
 *         explicitly so the real pipeline keeps being tested.
 *   While the demo is ON, no provider is ever called: photos included, every
 *   scripted prompt gets its canned answer. Set `DEMO_MOCK=0` in the hosting
 *   provider's environment variables once the recording is done — that single
 *   variable restores the real Gemini / Hugging Face pipeline everywhere.
 *   Every mocked turn is logged loudly on the server as `[Demo Mock]` and the
 *   response carries a `warnings` note, so a mock answer is never mistakable
 *   for a real model answer.
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
 * Simulated network round-trip for a TEXT turn. 600 ms sits in the sweet spot
 * for a demo: fast enough to keep the recording tight, slow enough that the
 * thinking indicator is visible and the answer does not look suspiciously
 * canned.
 */
const DEMO_MOCK_TEXT_DELAY_MS = 600;

/**
 * Simulated round-trip for a PHOTO turn: a full 5 s, because that is the beat
 * a real vision diagnosis needs. The chat walks its thinking label through
 * the pipeline phases while a photo is in flight (`جارٍ تحديد الورقة
 * واقتصاص الخلفية…` for the first 2.6 s, then `جارٍ تحليل الصورة وتشخيص
 * المرض…`), so 5 s lets the on-camera viewer see BOTH phases before the
 * diagnosis card lands. Still far below every timeout in play: the client
 * sets none, and this is a single serverless response well inside Vercel's
 * function window.
 */
const DEMO_MOCK_IMAGE_DELAY_MS = 5000;

/**
 * Line that identifies a SCRIPTED photo answer. The UI strips photos but keeps
 * the assistant's text when a conversation is sent back as `history`, so this
 * header (carried by every photo reply) is how the mock counts the photos the
 * presenter has already shown — which is what makes the second leaf of the
 * recording get the SECOND scripted diagnosis (Dieback) instead of repeating
 * the first one.
 */
const PHOTO_REPLY_MARKER = "نتيجة تشخيص الصورة";

/** Explicit opt-OUT values: `DEMO_MOCK=0` (or any of these) restores the real
 *  pipeline; an unset/unknown value leaves the demo script in charge. */
const DISABLING = new Set(["0", "false", "off", "no", "n", "disabled"]);

/**
 * Is the demo mock enabled for this process?
 *
 * ON BY DEFAULT: only an explicit disabling token turns it off, so a freshly
 * deployed recording environment (Vercel, preview, local dev with no
 * `.env.local`) serves the scripted demo answers with zero configuration —
 * requiring an env var there was how a recording session silently ended up
 * with the old "basic mode" fallback reply instead of the script.
 *
 * Reads `process.env` on every call (never cached at module load) so a flag
 * added to `.env.local` or to the hosting provider's variables is picked up by
 * the next request without a rebuild.
 */
export function isDemoMockEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.DEMO_MOCK ?? env.PHYTOSCAN_DEMO_MOCK ?? "").trim().toLowerCase();
  return !DISABLING.has(raw);
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

/** 5 · تحليل الصور — الصورة الأولى: احتراق الحواف (إجهاد فيزيولوجي + خلل تسميدي) */
const FIRST_IMAGE_REPLY = `[ 🔍 لم يُعثر على ورقة واحدة — شُخِّصت الصورة كاملة. ]

🧪 نتيجة تشخيص الصورة

### **احتراق حواف الأوراق والجفاف الأنسجي (Leaf Scorch / Tip Burn)**

**نسبة الثقة:** \`88% · ثقة مرتفعة\`

يُظهر التحليل البصري وجود احتراق نسيجي حاد على حواف الأوراق النامية، متبوعاً بنطاق اصفرار (Chlorosis) جاف. يعود هذا العارض أساساً إلى إجهاد حراري ونتحي متزايد مصحوب بتذبذب في دورات السقي وتراكم موضعي للأملاح في منطقة الجذور (Salinity Stress)، مما يؤدي إلى عدم قدرة النبتة على نقل عنصر الكالسيوم والبوتاسيوم إلى النهايات الطرفية للورقة خلال أوقات ذروة الحرارة.

**خطة علاج ووقاية:**

\`1\` **اسم المنتج العلاجي:** أكسي كلورور النحاس 50% + سماد ورقي غني بالبوتاسيوم والأحماض الأمينية (مثل Humic/Fulvic Acids)

• **الجرعة الموصى بها:** 200 غرام من أكسي كلورور النحاس + 150 مل من السماد الورقي لكل 100 لتر ماء (أو 2غ/لتر)

• **طريقة التطبيق:** رش ورقي متجانس يغطي كامل المجموع الخضري في الصباح الباكر (قبل الساعة 8:00 صباحاً) لتفادي ظاهرة احتراق قطرات الرش تحت أشعة الشمس. تُكرر المعالجة بعد 8 إلى 10 أيام.

• **البدائل المتاحة محلياً:** استخدام مركب **مانكوزيب 80%** (Mancozeb) كوقاية فطرية مساندة، أو رش **نترات الكالسيوم** المخلبية لتقوية الجدر الخلوية.

• **ملاحظات ميدانية:** يجب تعديل حموضة مياه الرش (pH) لتكون بين 6.0 و6.5 لضمان أقصى امتصاص للسماد الورقي، مع تجنب الري في ظهيرة الأيام الحارة.

\`1\` **البروتوكول الوقائي:**

• ضبط جدول السقي بنظام التقطير (Goutte-à-goutte) في الصباح الباكر، وإضافة الأحماض الهيوميكية للتربة لمعالجة الملوحة وتحسين نفاذية الجذور.`;

/** 5 · تحليل الصور — الصورة الثانية: تيبس الأغصان (إصابة فطرية وعائية) */
const SECOND_IMAGE_REPLY = `[ 🔍 لم يُعثر على ورقة واحدة — شُخِّصت الصورة كاملة. ]

🧪 نتيجة تشخيص الصورة

### **تيبس الأغصان والموت الخلفي الفطري (Dieback / Botryosphaeria Canker)**

**نسبة الثقة:** \`85% · ثقة مرتفعة\`

تُظهر الصورة إصابة وعائية تقدمية تمتد من أطراف الأغصان نحو القاعدة (Retrograde Drying)، وتتميز بجفاف الحطب واختفاء العصارة مع ظهور تلون بني داكن تحت اللحاء. تنتج هذه الحالة عن هجوم فطري وعائي (غالباً من عائلة *Botryosphaeriaceae* أو *Fusarium*) يخترق النبات عبر جروح التقليم غير المعالجة أو الصدمات الميكانيكية، مما يسبب انسداد الأوعية الناقلة للماء (Xylem Vessels) وموت الأنسجة الهيكلية.

**خطة علاج ووقاية:**

\`1\` **اسم المنتج العلاجي:** مبيد فطر وعائي مركّب: **مانكوزيب 80%** (Mancozeb) + **تيفانات الميثيل 70%** (Thiophanate-Methyl)

• **الجرعة الموصى بها:** 150 غرام من المانكوزيب + 100 غرام من تيفانات الميثيل لكل 100 لتر ماء

• **طريقة التطبيق:** أولاً، إجراء تقليم صحي صارم بقص الأجزاء الميتة مع زيادة 3 إلى 5 سم في الخشب الحي السليم. ثانياً، طلاء جروح القص الكبيرة بعجينة بوردو (Mastic / Bouillie Bordelaise)، ثم رش الشجرة بالكامل بالمحلول الفطري المذكور.

• **البدائل المتاحة محلياً:** استخدام **كلوروثالونيل 50%** أو **هيكساكونازول 5%** لمعالجة الجهاز الوعائي للنبات.

• **ملاحظات ميدانية:** يجب تطهير أدوات التقليم (المقلم/المنشار) بعد كل شجرة باستخدام كحول 70° أو ماء الجافيل المخفف لتفادي نقل العدوى بين الأشجار السليمة.

\`1\` **البروتوكول الوقائي:**

• جمع كافة الأغصان المقصوصة والمصابة وحرقها فوراً خارج الضيعة، وتجنب إحداث جروح ميكانيكية في الساق أثناء عمليات العزق والخدمة.`;

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
 * resend earlier base64 payloads), so counting user turns alone would always
 * yield 1 and the second photo would repeat the first diagnosis. Every earlier
 * SCRIPTED photo answer ({@link PHOTO_REPLY_MARKER}) is therefore counted as
 * one photo already shown.
 */
function countImages(messages: readonly DemoMockMessage[]): number {
  const markerInAssistantTurns = messages.filter(
    (message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      normalize(message.content).includes(normalize(PHOTO_REPLY_MARKER)),
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
 * Accepts the same `{ role, content, image? }` turns the route builds — plus
 * the legacy `imageUrl` alias some stored turns still carry, which is why the
 * parameter is the {@link DemoMockMessage} contract (both photo fields are
 * understood, see {@link countImages}).
 *
 * The simulated delay (600 ms text / 5 s photo) is applied ONLY when a match
 * was found, so a
 * non-scripted turn never pays for it before reaching the real pipeline.
 */
export async function getDemoMockResponse(messages: DemoMockMessage[]): Promise<string | null> {
  if (!messages || messages.length === 0) return null;

  const userMessages = messages.filter((message) => message.role === "user");
  const lastUserMsg = userMessages[userMessages.length - 1];
  if (!lastUserMsg) return null;

  const text = (lastUserMsg.content || "").trim().toLowerCase();
  const hasImage = Boolean(lastUserMsg.image || lastUserMsg.imageUrl);
  const totalImages = countImages(messages);

  const reply = resolveScriptedReply(
    // `text` is already lowercased; the Arabic normalisation inside
    // `includesAny` still applies (tashkeel/alef/ة-ى unification).
    text,
    hasImage,
    totalImages,
  );
  if (reply === null) return null;

  // Simulated round-trip, split by turn type so the recording feels field-real:
  // 5 s when a photo is being "analysed" (the UI's detection → vision phases
  // both get their beat), 600 ms for a text answer. Paid ONLY by a scripted
  // turn — a prompt outside the script reaches the real pipeline immediately
  // instead of waiting behind a mock that will not answer it.
  await new Promise((resolve) =>
    setTimeout(resolve, hasImage ? DEMO_MOCK_IMAGE_DELAY_MS : DEMO_MOCK_TEXT_DELAY_MS),
  );
  return reply;
}
