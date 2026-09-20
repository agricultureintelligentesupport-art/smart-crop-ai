"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  FlaskConical,
  Globe2,
  Leaf,
  LockKeyhole,
  Mail,
  MapPin,
  Phone,
  Sprout,
  TrendingUp,
  UserRound,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

type Language = "ar" | "fr";
type AuthMode = "signin" | "signup";
type Method = "email" | "phone";
type Role = "farmer" | "agronomist" | "investor";

const wilayas = ["بسكرة · Biskra", "خنشلة · Khenchela", "قالمة · Guelma", "الوادي · El Oued", "الجزائر · Alger", "البليدة · Blida", "سطيف · Sétif", "وهران · Oran", "تيزي وزو · Tizi Ouzou"];

const roles: { id: Role; icon: typeof Leaf; ar: string; fr: string; detail: string }[] = [
  { id: "farmer", icon: Sprout, ar: "فلاح / صاحب مزرعة", fr: "Agriculteur / Propriétaire", detail: "أدوات تساعدك على تنمية محصولك" },
  { id: "agronomist", icon: FlaskConical, ar: "مهندس زراعي / مستشار", fr: "Agronome / Consultant", detail: "رؤى دقيقة لمرافقة الفلاحين" },
  { id: "investor", icon: TrendingUp, ar: "مستثمر / مهتم بالقطاع", fr: "Investisseur / Passionné", detail: "اكتشف فرص الزراعة الحديثة" },
];

export default function AuthWorkflow() {
  const [language, setLanguage] = useState<Language>("ar");
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState<AuthMode>("signin");
  const [method, setMethod] = useState<Method>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [wilaya, setWilaya] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  const isArabic = language === "ar";
  const passwordScore = useMemo(() => [password.length >= 8, /[A-Z]/.test(password), /\d/.test(password)].filter(Boolean).length, [password]);

  // Firebase-ready handlers: replace the mock body with Firebase Auth calls.
  const handleGoogleAuth = async () => {
    setLoading(true); setNotice(isArabic ? "جاري فتح حساب Google…" : "Ouverture de Google…");
    await new Promise((resolve) => setTimeout(resolve, 500));
    setLoading(false); setStep(2); setNotice("");
  };
  const handleSendOTP = async () => {
    setLoading(true); setNotice("");
    await new Promise((resolve) => setTimeout(resolve, 500));
    setOtpSent(true); setLoading(false); setNotice(isArabic ? "تم إرسال رمز التحقق إلى هاتفك" : "Code envoyé sur votre téléphone");
  };
  const handleVerifyOTP = async () => {
    setLoading(true); await new Promise((resolve) => setTimeout(resolve, 500)); setLoading(false); setStep(2);
  };
  const handleEmailAuth = async () => {
    setLoading(true); setNotice("");
    await new Promise((resolve) => setTimeout(resolve, 500)); setLoading(false); setStep(mode === "signup" ? 2 : 2);
  };

  const submitAuth = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (method === "phone") {
      if (otpSent) void handleVerifyOTP();
      else void handleSendOTP();
    } else {
      void handleEmailAuth();
    }
  };
  const nextStep = () => { if (step === 2 && !role) return; if (step === 3 && !wilaya) return; setStep((current) => Math.min(3, current + 1)); };

  return (
    <main className="auth-shell" dir={isArabic ? "rtl" : "ltr"}>
      <div className="auth-orb auth-orb-one" /><div className="auth-orb auth-orb-two" />
      <header className="auth-header">
        <Link href="/" className="brand-lockup" aria-label="Smart Crop home"><span className="brand-mark"><Leaf size={22} /></span><span><strong>Smart Crop</strong><small>{isArabic ? "الزراعة الذكية" : "Agriculture intelligente"}</small></span></Link>
        <div className="language-switcher" role="group" aria-label="Language switcher"><Globe2 size={15} /><button className={language === "ar" ? "active" : ""} onClick={() => setLanguage("ar")}>AR</button><span>/</span><button className={language === "fr" ? "active" : ""} onClick={() => setLanguage("fr")}>FR</button></div>
      </header>

      <section className="auth-layout">
        <aside className="auth-intro">
          <div className="eyebrow"><span className="pulse-dot" /> {isArabic ? "من الأرض إلى المستقبل" : "De la terre au futur"}</div>
          <h1>{isArabic ? "ازرع بثقة، واحصد بذكاء." : "Cultivez mieux. Récoltez plus."}</h1>
          <p>{isArabic ? "منصة واحدة لقرارات زراعية أوضح، محصول أقوى، ومستقبل أخضر." : "Une seule plateforme pour des décisions plus claires et un avenir agricole plus vert."}</p>
          <div className="intro-stats"><div><strong>+2.4K</strong><span>{isArabic ? "مزرعة نشطة" : "fermes actives"}</span></div><div><strong>34</strong><span>{isArabic ? "ولاية جزائرية" : "wilayas"}</span></div></div>
          <div className="leaf-illustration"><div className="sun" /><div className="field field-back" /><div className="field field-front" /><Sprout className="big-sprout" size={102} strokeWidth={1.2} /></div>
        </aside>

        <div className="auth-card glass">
          <div className="stepper" aria-label="Progress"><div className="stepper-line"><span style={{ width: `${((step - 1) / 2) * 100}%` }} /></div>{[1, 2, 3].map((number) => <div className={`step-node ${step >= number ? "completed" : ""}`} key={number}><span>{step > number ? <Check size={14} /> : number}</span><small>{number === 1 ? (isArabic ? "الحساب" : "Compte") : number === 2 ? (isArabic ? "الصفة" : "Profil") : (isArabic ? "الموقع" : "Lieu")}</small></div>)}</div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={step} initial={{ opacity: 0, x: isArabic ? 18 : -18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: isArabic ? -18 : 18 }} transition={{ duration: .24 }}>
              {step === 1 && <AuthStep isArabic={isArabic} mode={mode} setMode={setMode} method={method} setMethod={setMethod} email={email} setEmail={setEmail} password={password} setPassword={setPassword} phone={phone} setPhone={setPhone} otp={otp} setOtp={setOtp} otpSent={otpSent} showPassword={showPassword} setShowPassword={setShowPassword} score={passwordScore} onSubmit={submitAuth} onGoogle={handleGoogleAuth} loading={loading} notice={notice} />}
              {step === 2 && <RoleStep isArabic={isArabic} role={role} setRole={setRole} onNext={nextStep} onBack={() => setStep(1)} />}
              {step === 3 && <LocationStep isArabic={isArabic} wilaya={wilaya} setWilaya={setWilaya} onNext={nextStep} onBack={() => setStep(2)} />}
            </motion.div>
          </AnimatePresence>
          <Link href="/guest" className="guest-link"><UsersRound size={17} /> {isArabic ? "متابعة كزائر" : "Continuer comme invité"} <ArrowLeft size={15} /></Link>
        </div>
      </section>
      <footer className="auth-footer">© 2025 Smart Crop <span>•</span> {isArabic ? "بياناتك محمية وآمنة" : "Vos données sont protégées"} <LockKeyhole size={13} /></footer>
    </main>
  );
}

type AuthStepProps = { isArabic: boolean; mode: AuthMode; setMode: (v: AuthMode) => void; method: Method; setMethod: (v: Method) => void; email: string; setEmail: (v: string) => void; password: string; setPassword: (v: string) => void; phone: string; setPhone: (v: string) => void; otp: string; setOtp: (v: string) => void; otpSent: boolean; showPassword: boolean; setShowPassword: (v: boolean) => void; score: number; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onGoogle: () => void; loading: boolean; notice: string };
function AuthStep(p: AuthStepProps) {
  const title = p.mode === "signup" ? (p.isArabic ? "أنشئ حسابك وابدأ" : "Créez votre compte") : (p.isArabic ? "مرحباً بعودتك" : "Bon retour parmi nous");
  return <div><div className="card-heading"><span className="mini-icon"><UserRound size={18} /></span><div><h2>{title}</h2><p>{p.isArabic ? "بياناتك الزراعية، في مكان واحد." : "Vos données agricoles, au même endroit."}</p></div></div><div className="mode-tabs"><button className={p.mode === "signin" ? "selected" : ""} onClick={() => p.setMode("signin")}>{p.isArabic ? "تسجيل الدخول" : "Se connecter"}</button><button className={p.mode === "signup" ? "selected" : ""} onClick={() => p.setMode("signup")}>{p.isArabic ? "إنشاء حساب" : "Créer un compte"}</button></div><button className="google-button" onClick={p.onGoogle}><span className="google-g">G</span>{p.isArabic ? "المتابعة باستخدام Google" : "Continuer avec Google"}<ArrowRight size={17} /></button><div className="divider"><span>{p.isArabic ? "أو باستخدام" : "ou avec"}</span></div><div className="method-tabs"><button className={p.method === "email" ? "selected" : ""} onClick={() => p.setMethod("email")}><Mail size={16} /> Email</button><button className={p.method === "phone" ? "selected" : ""} onClick={() => p.setMethod("phone")}><Phone size={16} /> {p.isArabic ? "الهاتف" : "Téléphone"}</button></div><form onSubmit={p.onSubmit}>{p.method === "email" ? <><label>{p.isArabic ? "البريد الإلكتروني" : "Adresse e-mail"}<div className="input-wrap"><Mail size={17} /><input required type="email" value={p.email} onChange={(e) => p.setEmail(e.target.value)} placeholder="you@example.com" /></div></label><label>{p.isArabic ? "كلمة المرور" : "Mot de passe"}<div className="input-wrap"><LockKeyhole size={17} /><input required minLength={6} type={p.showPassword ? "text" : "password"} value={p.password} onChange={(e) => p.setPassword(e.target.value)} placeholder="••••••••" /><button type="button" className="icon-button" aria-label={p.showPassword ? "Hide password" : "Show password"} onClick={() => p.setShowPassword(!p.showPassword)}>{p.showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>{p.mode === "signup" && <div className="strength"><span className={`strength-bar s${p.score}`} /><small>{p.score < 2 ? (p.isArabic ? "قوة كلمة المرور: ضعيفة" : "Faible") : p.score === 2 ? (p.isArabic ? "متوسطة" : "Moyenne") : (p.isArabic ? "قوية" : "Forte")}</small></div>}</label></> : <>{!p.otpSent ? <label>{p.isArabic ? "رقم الهاتف" : "Numéro de téléphone"}<div className="phone-wrap"><span>+213</span><input required value={p.phone} onChange={(e) => p.setPhone(e.target.value.replace(/\D/g, ""))} placeholder="5 55 12 34 56" inputMode="tel" /></div><small className="helper">{p.isArabic ? "سنرسل لك رمز تحقق عبر SMS" : "Un code vous sera envoyé par SMS"}</small></label> : <label>{p.isArabic ? "رمز التحقق" : "Code de vérification"}<div className="input-wrap"><Phone size={17} /><input required value={p.otp} onChange={(e) => p.setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" inputMode="numeric" /></div></label>}</>}<button className="primary-button" type="submit" disabled={p.loading}>{p.loading ? "..." : p.method === "phone" ? (p.otpSent ? (p.isArabic ? "تأكيد الرمز" : "Vérifier le code") : (p.isArabic ? "إرسال رمز SMS" : "Envoyer le code SMS")) : (p.mode === "signup" ? (p.isArabic ? "إنشاء حساب والمتابعة" : "Créer et continuer") : (p.isArabic ? "تسجيل الدخول والمتابعة" : "Se connecter et continuer"))}<ArrowRight size={18} /></button></form>{p.notice && <p className="notice" role="status">{p.notice}</p>}<p className="terms">{p.isArabic ? "بالمتابعة، أنت توافق على شروط الاستخدام وسياسة الخصوصية." : "En continuant, vous acceptez nos conditions et notre politique de confidentialité."}</p></div>;
}

function RoleStep({ isArabic, role, setRole, onNext, onBack }: { isArabic: boolean; role: Role | null; setRole: (v: Role) => void; onNext: () => void; onBack: () => void }) {
  return <div><div className="card-heading"><span className="mini-icon"><Leaf size={18} /></span><div><h2>{isArabic ? "كيف ستستخدم Smart Crop؟" : "Comment utiliserez-vous Smart Crop ?"}</h2><p>{isArabic ? "اختر الصفة الأقرب إليك" : "Choisissez le profil qui vous correspond"}</p></div></div><div className="role-list">{roles.map((item) => { const Icon = item.icon; return <button key={item.id} className={`role-card ${role === item.id ? "selected" : ""}`} onClick={() => setRole(item.id)}><span className="role-icon"><Icon size={24} /></span><span><strong>{isArabic ? item.ar : item.fr}</strong><small>{item.detail}</small></span>{role === item.id && <Check size={18} className="role-check" />}</button>; })}</div><div className="step-actions"><button className="back-button" onClick={onBack}><ArrowLeft size={17} /> {isArabic ? "رجوع" : "Retour"}</button><button className="primary-button" disabled={!role} onClick={onNext}>{isArabic ? "المتابعة" : "Continuer"}<ArrowRight size={18} /></button></div></div>;
}

function LocationStep({ isArabic, wilaya, setWilaya, onNext, onBack }: { isArabic: boolean; wilaya: string; setWilaya: (v: string) => void; onNext: () => void; onBack: () => void }) {
  return <div><div className="card-heading"><span className="mini-icon"><MapPin size={18} /></span><div><h2>{isArabic ? "أين تقع مزرعتك؟" : "Où se trouve votre exploitation ?"}</h2><p>{isArabic ? "لنقدّم لك طقساً وتوصيات تناسب منطقتك." : "Pour des conseils météo adaptés à votre région."}</p></div></div><label className="location-label">{isArabic ? "الولاية" : "Wilaya"}<div className="select-wrap"><MapPin size={18} /><select required value={wilaya} onChange={(e) => setWilaya(e.target.value)}><option value="">{isArabic ? "اختر ولايتك" : "Choisissez votre wilaya"}</option>{wilayas.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={17} /></div></label><div className="location-tip"><Globe2 size={18} /><span>{isArabic ? "يمكنك تغيير موقعك لاحقاً من إعدادات الحساب." : "Vous pourrez modifier votre lieu depuis votre compte."}</span></div><div className="step-actions"><button className="back-button" onClick={onBack}><ArrowLeft size={17} /> {isArabic ? "رجوع" : "Retour"}</button><button className="primary-button" disabled={!wilaya} onClick={onNext}>{isArabic ? "البدء الآن" : "Commencer"}<ArrowRight size={18} /></button></div></div>;
}
