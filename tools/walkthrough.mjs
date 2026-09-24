/**
 * Visual walkthrough harness (dev-only).
 *
 * Drives the real UI in headless Chromium, walks every flow and writes a
 * screenshot per step to /tmp/shots — useful for reviewing the design and for
 * checking that every CTA routes somewhere real.
 *
 *   npm run dev                       # in one shell
 *   npm i -D @sparticuz/chromium      # optional: uses a prebuilt Chromium
 *   node tools/walkthrough.mjs all    # or: register | otp | login | google | narrow
 *
 * `npm run test:e2e` is the assertion-grade suite; this is the eyes-on one.
 */
import sparticuz from "@sparticuz/chromium";
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "/tmp/shots";
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const log = (...a) => console.log("•", ...a);

/** Fresh browser per flow: the sandbox Chromium build is single-process and
 *  gets unstable after a few contexts, and isolation keeps flows honest. */
async function launch() {
  return chromium.launch({
    executablePath: await sparticuz.executablePath(),
    args: sparticuz.args,
    headless: true,
  });
}

async function newPage(browser, label, viewport = { width: 412, height: 915 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ar-DZ" });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`[${label}] console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  return { ctx, page };
}

const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  log("shot", name);
};

const CREDS = { email: "mohamed@example.dz", password: "tomate2026", name: "محمد بن علي" };

/** Registers a full account through the UI and lands on /dashboard. */
async function registerFresh(page) {
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "البريد الإلكتروني" }).click();
  await page.getByLabel("الاسم الكامل").fill(CREDS.name);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(CREDS.email);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(CREDS.password);
  await page.getByLabel("تأكيد كلمة المرور").fill(CREDS.password);
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();
  await page.getByRole("heading", { name: "تحديد صفة المستخدم" }).waitFor({ timeout: 20000 });
  await page.getByRole("radio", { name: /صاحب مزرعة/ }).click();
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.getByRole("heading", { name: "اختيار الولاية" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "تأكيد الولاية" }).click();
  await page.getByRole("heading", { name: /أهلاً بك/ }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /الدخول إلى لوحة التحكم/ }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 20000 });
}

const flows = {
  async register() {
    const browser = await launch();
    const { ctx, page } = await newPage(browser, "register");
    try {
      await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
      await shot(page, "01-register-method-phone");

      await page.getByRole("tab", { name: "البريد الإلكتروني" }).click();
      await shot(page, "02-register-method-email");

      // validation feedback first
      await page.getByRole("button", { name: "إنشاء الحساب" }).click();
      await page.getByText("هذا الحقل مطلوب").first().waitFor({ timeout: 5000 });
      await shot(page, "03a-register-validation");

      await page.getByLabel("الاسم الكامل").fill(CREDS.name);
      await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill("bad-email");
      await page.getByLabel("كلمة المرور", { exact: true }).fill("weak");
      await page.getByRole("button", { name: "إنشاء الحساب" }).click();
      await page.getByText(/أدخل بريداً إلكترونياً صحيحاً/).waitFor({ timeout: 5000 });
      await page.getByText(/كلمة المرور ضعيفة/).waitFor({ timeout: 5000 });
      await shot(page, "03b-register-field-errors");

      await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(CREDS.email);
      await page.getByLabel("كلمة المرور", { exact: true }).fill(CREDS.password);
      await page.getByLabel("تأكيد كلمة المرور").fill("mismatch1");
      await page.getByRole("button", { name: "إنشاء الحساب" }).click();
      await page.getByText(/غير متطابقتين/).waitFor({ timeout: 5000 });
      await shot(page, "03c-password-mismatch");

      await page.getByLabel("تأكيد كلمة المرور").fill(CREDS.password);
      await shot(page, "03d-register-email-filled");

      await page.getByRole("button", { name: "إنشاء الحساب" }).click();
      await page.getByRole("heading", { name: "تحديد صفة المستخدم" }).waitFor({ timeout: 20000 });
      await shot(page, "04-role");

      await page.getByRole("radio", { name: /صاحب مزرعة/ }).click();
      await shot(page, "05-role-selected");

      await page.getByRole("button", { name: "متابعة" }).click();
      await page.getByRole("heading", { name: "اختيار الولاية" }).waitFor({ timeout: 10000 });
      await shot(page, "06-wilaya");

      await page.getByRole("searchbox", { name: "البحث عن ولاية" }).fill("خنشلة");
      await shot(page, "07-wilaya-search");
      await page.getByRole("button", { name: /خنشلة/ }).first().click();
      await page.getByRole("searchbox", { name: "البحث عن ولاية" }).fill("zzz");
      await page.getByText("لا توجد نتائج مطابقة").waitFor({ timeout: 5000 });
      await shot(page, "08-wilaya-empty");
      await page.getByRole("searchbox", { name: "البحث عن ولاية" }).fill("");
      await shot(page, "08b-wilaya-selected");

      await page.getByRole("button", { name: "تأكيد الولاية" }).click();
      await page.getByRole("heading", { name: /أهلاً بك/ }).waitFor({ timeout: 20000 });
      await shot(page, "09-success");

      await page.getByRole("button", { name: /الدخول إلى لوحة التحكم/ }).click();
      await page.waitForURL(/\/dashboard/, { timeout: 20000 });
      await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 20000 });
      await shot(page, "10-member-dashboard");
      log("register →", page.url());
    } finally {
      await ctx.close();
      await browser.close();
    }
  },

  async otp() {
    const browser = await launch();
    const { ctx, page } = await newPage(browser, "otp");
    try {
      await page.goto(`${BASE}/auth`, { waitUntil: "networkidle" });

      // invalid phone first
      await page.getByRole("textbox", { name: "الهاتف" }).fill("123");
      await page.getByRole("button", { name: /إرسال رمز SMS/ }).click();
      await page.getByText(/رقم جوال جزائري صحيح/).waitFor({ timeout: 5000 });
      await shot(page, "11a-phone-invalid");

      await page.getByRole("textbox", { name: "الهاتف" }).fill("661223344");
      await page.getByRole("button", { name: /إرسال رمز SMS/ }).click();
      await page.getByLabel("رمز التحقق").waitFor({ timeout: 20000 });
      await shot(page, "11b-otp-pending");

      // wrong code
      await page.getByLabel("رمز التحقق").fill("000000");
      await page.getByRole("button", { name: /تحقّق ودخول/ }).click();
      await page.getByText(/الرمز غير صحيح/).waitFor({ timeout: 20000 });
      await shot(page, "11c-otp-error");

      // correct code
      await page.getByLabel("رمز التحقق").fill("123456");
      await shot(page, "12-otp-filled");
      await page.getByRole("button", { name: /تحقّق ودخول/ }).click();
      await page.getByRole("heading", { name: "تحديد صفة المستخدم" }).waitFor({ timeout: 20000 });
      log("OTP verified → role step");
      await shot(page, "13-otp-role");

      // resend + change-number affordances
      await page.getByRole("button", { name: "رجوع" }).click();
      await page.getByRole("button", { name: "تغيير الرقم" }).click();
      await shot(page, "13b-change-number");
    } finally {
      await ctx.close();
      await browser.close();
    }
  },

  async login() {
    const browser = await launch();
    const { ctx, page } = await newPage(browser, "login");
    try {
      await registerFresh(page);
      log("seeded account, signing out");

      // Sign-out lives in the account sheet ("حسابي" tab) since the header
      // relocation.
      await page.getByRole("button", { name: "حسابي" }).click();
      await page.getByRole("button", { name: "تسجيل الخروج" }).click();
      await page.waitForURL(/\/auth/, { timeout: 20000 });
      await shot(page, "15a-signed-out");

      // returning member on a known device: the setup steps drop off the plan
      await page.getByRole("tab", { name: "البريد الإلكتروني" }).click();
      await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(CREDS.email);
      await page.getByLabel("كلمة المرور", { exact: true }).fill(CREDS.password);
      await page.getByRole("tabpanel").getByRole("button", { name: "تسجيل الدخول" }).click();
      await page.waitForURL(/\/dashboard/, { timeout: 20000 });
      log("login →", page.url());
      await shot(page, "15b-login-dashboard");

      // wrong password
      await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
      await page.getByRole("tab", { name: "البريد الإلكتروني" }).click();
      await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(CREDS.email);
      await page.getByLabel("كلمة المرور", { exact: true }).fill("wrongpass1");
      await page.getByRole("tabpanel").getByRole("button", { name: "تسجيل الدخول" }).click();
      await page.getByText(/كلمة المرور غير صحيحة/).waitFor({ timeout: 20000 });
      await shot(page, "16-login-error");

      // unknown account
      await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill("ghost@example.dz");
      await page.getByRole("tabpanel").getByRole("button", { name: "تسجيل الدخول" }).click();
      await page.getByText(/لا يوجد حساب بهذا البريد/).waitFor({ timeout: 20000 });
      await shot(page, "16b-login-unknown");
    } finally {
      await ctx.close();
      await browser.close();
    }
  },

  async google() {
    const browser = await launch();
    const { ctx, page } = await newPage(browser, "google");
    try {
      await page.goto(`${BASE}/auth`, { waitUntil: "networkidle" });
      // The Google button opens the REAL Firebase OAuth popup (strict auth —
      // the wizard never advances without a real Firebase user), which a human
      // completes. The automated walk screenshots the button, then enters the
      // wizard through the demo phone OTP (same role → wilaya → success path).
      await shot(page, "14a-google-button");
      await page.getByRole("textbox", { name: "الهاتف" }).fill("661223344");
      await page.getByRole("button", { name: /إرسال رمز SMS/ }).click();
      await page.getByLabel("رمز التحقق").fill("123456");
      await page.getByRole("button", { name: /تحقّق ودخول/ }).click();
      await page.getByRole("heading", { name: "تحديد صفة المستخدم" }).waitFor({ timeout: 20000 });
      await shot(page, "14b-google-role");
      await page.getByRole("radio", { name: /مهندس زراعي/ }).click();
      await page.getByRole("button", { name: "متابعة" }).click();
      await page.getByRole("searchbox", { name: "البحث عن ولاية" }).fill("Setif");
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: /سِطيف|سطيف/ }).first().click();
      await page.getByRole("button", { name: "تأكيد الولاية" }).click();
      await page.getByRole("heading", { name: /أهلاً بك/ }).waitFor({ timeout: 20000 });
      await shot(page, "14b-google-success");
      // French sidebar check on the success screen
      await page.getByRole("button", { name: "Français" }).click();
      await shot(page, "14c-success-french");
      log("google → role → wilaya → success OK");
    } finally {
      await ctx.close();
      await browser.close();
    }
  },

  async narrow() {
    const browser = await launch();
    const { ctx, page } = await newPage(browser, "narrow", { width: 320, height: 568 });
    try {
      await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
      await shot(page, "26-narrow-register-ar");
      await page.getByRole("button", { name: "Français" }).click();
      await shot(page, "27-narrow-register-fr");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`[narrow] horizontal overflow ${overflow}px`);
      const small = await page.evaluate(
        () =>
          [...document.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().height < 32).length,
      );
      if (small > 0) problems.push(`[narrow] ${small} buttons under 32px tall`);
    } finally {
      await ctx.close();
      await browser.close();
    }
  },
};

const wanted = process.argv[2] ?? "all";
const names = wanted === "all" ? Object.keys(flows) : [wanted];

for (const name of names) {
  if (!flows[name]) {
    console.error(`unknown flow: ${name}`);
    continue;
  }
  console.log(`\n=== flow: ${name} ===`);
  try {
    await flows[name]();
  } catch (error) {
    problems.push(`[${name}] FAILED: ${error.message.split("\n")[0]}`);
  }
}

console.log("\n=== PROBLEMS ===");
console.log(problems.length ? problems.join("\n") : "none");
process.exit(problems.length ? 1 : 0);
