/**
 * Bilingual copy for the auth flow.
 *
 * Shape-first: `AR` is the source of truth, `AuthCopy` is derived from it, and
 * `AUTH` is typed as `Record<Lang, AuthCopy>` so a missing French key is a
 * compile error rather than a blank label in production.
 */

import type { Lang } from "@/lib/wilayas";

export interface RoleCopy {
  label: string;
  tag: string;
  description: string;
  perks: string[];
}

export interface AuthCopy {
  header: {
    brand: string;
    brandTag: string;
    navHome: string;
    navDashboard: string;
    navSignIn: string;
    navCreateAccount: string;
    signOut: string;
    langAria: string;
    langAr: string;
    langFr: string;
  };
  steps: {
    aria: string;
    method: string;
    role: string;
    location: string;
    done: string;
    stepWord: string;
    ofWord: string;
  };
  method: {
    titleSignin: string;
    titleRegister: string;
    subtitleSignin: string;
    subtitleRegister: string;
    switchAria: string;
    switchToSignin: string;
    switchToRegister: string;
    tabSignin: string;
    tabRegister: string;
    google: string;
    googleBusy: string;
    googleNote: string;
    googleRedirecting: string;
    errorCode: string;
    errorMessage: string;
    errorHint: string;
    errorDiagnostics: string;
    errorCopy: string;
    errorCopied: string;
    divider: string;
    channelsAria: string;
    channelPhone: string;
    channelEmail: string;
  };
  phone: {
    title: string;
    subtitle: string;
    prefixAria: string;
    placeholder: string;
    helper: string;
    send: string;
    sending: string;
    sentTo: string;
    changeNumber: string;
    otpLabel: string;
    otpHint: string;
    verify: string;
    verifying: string;
    resend: string;
    resendIn: string;
    resent: string;
    expiresIn: string;
    attempts: string;
  };
  email: {
    name: string;
    namePlaceholder: string;
    email: string;
    emailPlaceholder: string;
    password: string;
    passwordPlaceholder: string;
    confirm: string;
    confirmPlaceholder: string;
    show: string;
    hide: string;
    forgot: string;
    forgotSent: string;
    submitSignin: string;
    submitRegister: string;
    busy: string;
    terms: string;
    strengthAria: string;
    strengthLabels: [string, string, string, string, string];
    ruleLength: string;
    ruleLetter: string;
    ruleNumber: string;
  };
  demo: {
    badge: string;
    otpTitle: string;
    otpBody: string;
    noteTitle: string;
    noteBody: string;
  };
  errors: {
    required: string;
    email: string;
    phone: string;
    passwordWeak: string;
    passwordMismatch: string;
    otpIncomplete: string;
    invalidCode: string;
    codeExpired: string;
    emailInUse: string;
    userNotFound: string;
    wrongPassword: string;
    tooMany: string;
    popupClosed: string;
    popupBlocked: string;
    storageBlocked: string;
    unauthorizedDomain: string;
    operationNotSupported: string;
    profileSave: string;
    network: string;
    unknown: string;
  };
  role: {
    title: string;
    subtitle: string;
    hint: string;
    confirm: string;
    back: string;
    options: {
      farmer: RoleCopy;
      agronomist: RoleCopy;
      investor: RoleCopy;
    };
  };
  location: {
    title: string;
    subtitle: string;
    search: string;
    searchPlaceholder: string;
    results: string;
    empty: string;
    emptyHint: string;
    selectedLabel: string;
    confirm: string;
    back: string;
    regionLabel: string;
    altitudeLabel: string;
    soilLabel: string;
    climateLabel: string;
    cropsLabel: string;
    tempLabel: string;
    humidityLabel: string;
    windLabel: string;
    rainLabel: string;
    humidity: string;
    wind: string;
    rain: string;
    clear: string;
  };
  success: {
    title: string;
    subtitle: string;
    summaryTitle: string;
    summaryMethod: string;
    summaryRole: string;
    summaryWilaya: string;
    cta: string;
    secondary: string;
    perks: string[];
  };
  back: string;
  cancel: string;
  retry: string;
}

const AR: AuthCopy = {
  header: {
    brand: "محصولي الذكي",
    brandTag: "منصّة الزراعة الذكية",
    navHome: "الرئيسية",
    navDashboard: "لوحة التحكم",
    navSignIn: "تسجيل الدخول",
    navCreateAccount: "إنشاء حساب",
    signOut: "تسجيل الخروج",
    langAria: "اختيار اللغة",
    langAr: "العربية",
    langFr: "Français",
  },
  steps: {
    aria: "مراحل إعداد الحساب",
    method: "الطريقة",
    role: "الصفة",
    location: "الولاية",
    done: "مكتملة",
    stepWord: "خطوة",
    ofWord: "من",
  },
  method: {
    titleSignin: "تسجيل الدخول",
    titleRegister: "إنشاء حساب جديد",
    subtitleSignin: "تابع مزرعتك من حيث توقفت.",
    subtitleRegister: "دقيقة واحدة لتفعيل التشخيص الذكي والسقي الدقيق.",
    switchAria: "اختيار بين تسجيل الدخول وإنشاء حساب",
    switchToSignin: "تبويب تسجيل الدخول",
    switchToRegister: "تبويب إنشاء حساب",
    tabSignin: "دخول",
    tabRegister: "حساب جديد",
    google: "المتابعة بحساب Google",
    googleBusy: "جارٍ الاتصال بـ Google…",
    googleNote: "لا نصل إلى كلمة مرورك ولا نخزّنها",
    googleRedirecting: "أعدنا تحويلك إلى Google لإكمال تسجيل الدخول…",
    errorCode: "الرمز",
    errorMessage: "الرسالة",
    errorHint: "الحل المقترح",
    errorDiagnostics: "تشخيص Firebase",
    errorCopy: "نسخ التفاصيل",
    errorCopied: "تم نسخ التفاصيل",
    divider: "أو",
    channelsAria: "طريقة التحقق",
    channelPhone: "الهاتف",
    channelEmail: "البريد الإلكتروني",
  },
  phone: {
    title: "التحقق عبر الهاتف",
    subtitle: "أدخل رقم جوالك الجزائري لنرسل إليك رمز تحقق من 6 أرقام.",
    prefixAria: "مفتاح الدولة",
    placeholder: "6 61 22 33 44",
    helper: "أرقام الجوال تبدأ بـ 5 أو 6 أو 7",
    send: "إرسال رمز SMS",
    sending: "جارٍ إرسال الرمز…",
    sentTo: "أرسلنا رمزاً من 6 أرقام إلى",
    changeNumber: "تغيير الرقم",
    otpLabel: "رمز التحقق",
    otpHint: "أدخل الأرقام الستة الواردة في الرسالة",
    verify: "تحقّق ودخول",
    verifying: "جارٍ التحقق…",
    resend: "إعادة إرسال الرمز",
    resendIn: "إعادة الإرسال بعد {sec} ث",
    resent: "أرسلنا رمزاً جديداً.",
    expiresIn: "الرمز صالح لمدة {min} دقائق.",
    attempts: "بقي {n} محاولات",
  },
  email: {
    name: "الاسم الكامل",
    namePlaceholder: "مثال: محمد بن علي",
    email: "البريد الإلكتروني",
    emailPlaceholder: "name@example.com",
    password: "كلمة المرور",
    passwordPlaceholder: "8 أحرف على الأقل",
    confirm: "تأكيد كلمة المرور",
    confirmPlaceholder: "أعد كتابة كلمة المرور",
    show: "إظهار كلمة المرور",
    hide: "إخفاء كلمة المرور",
    forgot: "نسيت كلمة المرور؟",
    forgotSent: "أرسلنا رابط إعادة التعيين إلى {email}",
    submitSignin: "تسجيل الدخول",
    submitRegister: "إنشاء الحساب",
    busy: "جارٍ التحقق…",
    terms: "بإنشاء الحساب أنت توافق على شروط الاستخدام وسياسة الخصوصية.",
    strengthAria: "قوة كلمة المرور",
    strengthLabels: ["ضعيفة جداً", "ضعيفة", "متوسطة", "قوية", "قوية جداً"],
    ruleLength: "8 أحرف على الأقل",
    ruleLetter: "حرف واحد على الأقل",
    ruleNumber: "رقم واحد على الأقل",
  },
  demo: {
    badge: "وضع تجريبي",
    otpTitle: "رمز تجريبي",
    otpBody: "لا تُرسل رسائل حقيقية بعد. استخدم الرمز {code} لإتمام التحقق.",
    noteTitle: "ملاحظة الوضع التجريبي",
    noteBody: "الدخول عبر Google يتم عبر Firebase الفعلي، أما رسائل SMS فتبقى تجريبية على هذا الجهاز.",
  },
  errors: {
    required: "هذا الحقل مطلوب",
    email: "أدخل بريداً إلكترونياً صحيحاً",
    phone: "أدخل رقم جوال جزائري صحيح (يبدأ بـ 5 أو 6 أو 7)",
    passwordWeak: "كلمة المرور ضعيفة: 8 أحرف مع حرف ورقم على الأقل",
    passwordMismatch: "كلمتا المرور غير متطابقتين",
    otpIncomplete: "أدخل الرمز كاملاً (6 أرقام)",
    invalidCode: "الرمز غير صحيح، تحقق من الرسالة أو أعد الإرسال",
    codeExpired: "انتهت صلاحية الرمز، أعد الإرسال من فضلك",
    emailInUse: "هذا البريد مستعمل بالفعل، جرّب تسجيل الدخول",
    userNotFound: "لا يوجد حساب بهذا البريد",
    wrongPassword: "كلمة المرور غير صحيحة",
    tooMany: "محاولات كثيرة، انتظر قليلاً ثم أعد المحاولة",
    popupClosed: "أُغلقت نافذة Google قبل إكمال الدخول",
    popupBlocked: "تعذّر فتح نافذة Google المنبثقة (حظر النوافذ المنبثقة أو متصفح الجوال) — أعد المحاولة",
    storageBlocked:
      "هذا المتصفح يمنع تخزين الجلسة (Cookies/IndexedDB) — اسمح ببيانات الموقع لهذا النطاق ليصمد تسجيل الدخول بعد إعادة التحميل",
    unauthorizedDomain:
      "نطاق هذا الموقع غير مصرّح به في Firebase — أضِفه إلى Authorized domains في لوحة Firebase ثم أعد المحاولة",
    operationNotSupported: "هذا المتصفح لا يدعم نافذة الدخول ولا التحويل — جرّب متصفحًا آخر",
    profileSave: "تم تسجيل الدخول، لكن تعذّر حفظ الملف على السحابة — تفصيلة في سجل المتصفح (console)",
    network: "تعذّر الاتصال، تحقّق من شبكتك",
    unknown: "حدث خطأ غير متوقع، أعد المحاولة",
  },
  role: {
    title: "تحديد صفة المستخدم",
    subtitle: "نضبط التوصيات والتنبيهات حسب نشاطك في القطاع.",
    hint: "يمكنك تغييرها في أي وقت من الإعدادات.",
    confirm: "متابعة",
    back: "رجوع",
    options: {
      farmer: {
        label: "فلاح / صاحب مزرعة",
        tag: "الميدان",
        description: "تابع أرضك، شخّص الأمراض، واحسب مياه السقي يومياً.",
        perks: ["تشخيص الأمراض بالصور", "جدول سقي مناسب للمساحة", "تنبيهات الطقس والرياح"],
      },
      agronomist: {
        label: "مهندس زراعي / مستشار",
        tag: "الاستشارة",
        description: "رافق الفلاحين ببيانات دقيقة وتقارير قابلة للمشاركة.",
        perks: ["لوحة متعددة المستفيدين", "تقارير NDVI للأقمار", "سجل توصيات قابل للتصدير"],
      },
      investor: {
        label: "مستثمر / مهتم بالقطاع",
        tag: "الاستثمار",
        description: "اقرأ مؤشرات القطاع وفرص الاستثمار في السلسلة الزراعية.",
        perks: ["مؤشرات الإنتاج والمياه", "خرائط المناطق الواعدة", "متابعة أسعار المحاصيل"],
      },
    },
  },
  location: {
    title: "اختيار الولاية",
    subtitle: "نضبط الطقس الأولي والمحاصيل المقترحة حسب موقعك.",
    search: "البحث عن ولاية",
    searchPlaceholder: "اكتب اسم الولاية أو رقمها…",
    results: "{n} ولاية",
    empty: "لا توجد نتائج مطابقة",
    emptyHint: "جرّب الاسم بالعربية أو بالفرنسية، أو رقم الولاية.",
    selectedLabel: "الولاية المختارة",
    confirm: "تأكيد الولاية",
    back: "رجوع",
    regionLabel: "المنطقة",
    altitudeLabel: "الارتفاع",
    soilLabel: "نوع التربة",
    climateLabel: "الطقس المرجعي",
    cropsLabel: "أهم المحاصيل",
    tempLabel: "الحرارة",
    humidityLabel: "الرطوبة",
    windLabel: "الرياح",
    rainLabel: "الأمطار",
    humidity: "{n}%",
    wind: "رياح {n} كم/س",
    rain: "أمطار {n} مم/سنة",
    clear: "مسح البحث",
  },
  success: {
    title: "أهلاً بك في محصولي الذكي",
    subtitle: "ملفك جاهز، ولوحة المزرعة مهيّأة حسب اختياراتك.",
    summaryTitle: "ملخص الإعداد",
    summaryMethod: "طريقة الدخول",
    summaryRole: "الصفة",
    summaryWilaya: "الولاية",
    cta: "الدخول إلى لوحة التحكم",
    secondary: "تعديل الاختيارات",
    perks: [
      "الطقس والمحاصيل مضبوطة على ولايتك",
      "تنبيهات السقي والرياح مفعّلة",
      "بياناتك محفوظة على هذا الجهاز فقط",
    ],
  },
  back: "رجوع",
  cancel: "إلغاء",
  retry: "إعادة المحاولة",
};

const FR: AuthCopy = {
  header: {
    brand: "Smart Crop AI",
    brandTag: "Agriculture de précision",
    navHome: "Accueil",
    navDashboard: "Tableau de bord",
    navSignIn: "Connexion",
    navCreateAccount: "Créer un compte",
    signOut: "Se déconnecter",
    langAria: "Choix de la langue",
    langAr: "العربية",
    langFr: "Français",
  },
  steps: {
    aria: "Étapes de configuration du compte",
    method: "Méthode",
    role: "Profil",
    location: "Wilaya",
    done: "terminée",
    stepWord: "Étape",
    ofWord: "sur",
  },
  method: {
    titleSignin: "Connexion",
    titleRegister: "Créer un compte",
    subtitleSignin: "Reprenez le suivi de votre exploitation là où vous l'avez laissé.",
    subtitleRegister: "Une minute pour activer le diagnostic IA et l'irrigation de précision.",
    switchAria: "Choisir entre connexion et création de compte",
    switchToSignin: "Onglet connexion",
    switchToRegister: "Onglet création de compte",
    tabSignin: "Connexion",
    tabRegister: "Inscription",
    google: "Continuer avec Google",
    googleBusy: "Connexion à Google…",
    googleNote: "Nous n'accédons jamais à votre mot de passe",
    googleRedirecting: "Redirection vers Google pour terminer la connexion…",
    errorCode: "Code",
    errorMessage: "Message",
    errorHint: "Piste",
    errorDiagnostics: "Diagnostic Firebase",
    errorCopy: "Copier les détails",
    errorCopied: "Détails copiés",
    divider: "ou",
    channelsAria: "Méthode de vérification",
    channelPhone: "Téléphone",
    channelEmail: "E-mail",
  },
  phone: {
    title: "Vérification par téléphone",
    subtitle: "Saisissez votre numéro mobile algérien pour recevoir un code à 6 chiffres.",
    prefixAria: "Indicatif du pays",
    placeholder: "6 61 22 33 44",
    helper: "Les mobiles commencent par 5, 6 ou 7",
    send: "Envoyer le code SMS",
    sending: "Envoi du code…",
    sentTo: "Code à 6 chiffres envoyé au",
    changeNumber: "Changer de numéro",
    otpLabel: "Code de vérification",
    otpHint: "Saisissez les 6 chiffres reçus par SMS",
    verify: "Vérifier et continuer",
    verifying: "Vérification…",
    resend: "Renvoyer le code",
    resendIn: "Nouvel envoi dans {sec} s",
    resent: "Un nouveau code vient d'être envoyé.",
    expiresIn: "Le code reste valable {min} minutes.",
    attempts: "{n} essais restants",
  },
  email: {
    name: "Nom complet",
    namePlaceholder: "Ex. : Mohamed Benali",
    email: "Adresse e-mail",
    emailPlaceholder: "nom@exemple.com",
    password: "Mot de passe",
    passwordPlaceholder: "8 caractères minimum",
    confirm: "Confirmer le mot de passe",
    confirmPlaceholder: "Retapez le mot de passe",
    show: "Afficher le mot de passe",
    hide: "Masquer le mot de passe",
    forgot: "Mot de passe oublié ?",
    forgotSent: "Lien de réinitialisation envoyé à {email}",
    submitSignin: "Se connecter",
    submitRegister: "Créer le compte",
    busy: "Vérification…",
    terms: "En créant un compte, vous acceptez les conditions d'utilisation et la politique de confidentialité.",
    strengthAria: "Robustesse du mot de passe",
    strengthLabels: ["Très faible", "Faible", "Moyen", "Solide", "Très solide"],
    ruleLength: "8 caractères minimum",
    ruleLetter: "Au moins une lettre",
    ruleNumber: "Au moins un chiffre",
  },
  demo: {
    badge: "Mode démo",
    otpTitle: "Code de démonstration",
    otpBody: "Aucun SMS réel n'est envoyé. Utilisez le code {code} pour valider.",
    noteTitle: "Mode démo",
    noteBody:
      "La connexion Google passe par Firebase réel, mais les SMS restent simulés sur cet appareil.",
  },
  errors: {
    required: "Ce champ est obligatoire",
    email: "Saisissez une adresse e-mail valide",
    phone: "Numéro mobile algérien invalide (début 5, 6 ou 7)",
    passwordWeak: "Mot de passe trop faible : 8 caractères, une lettre et un chiffre",
    passwordMismatch: "Les deux mots de passe ne correspondent pas",
    otpIncomplete: "Saisissez les 6 chiffres du code",
    invalidCode: "Code incorrect, vérifiez le SMS ou renvoyez un code",
    codeExpired: "Code expiré, demandez un nouvel envoi",
    emailInUse: "Cette adresse est déjà utilisée, connectez-vous",
    userNotFound: "Aucun compte avec cette adresse",
    wrongPassword: "Mot de passe incorrect",
    tooMany: "Trop de tentatives, réessayez dans un instant",
    popupClosed: "La fenêtre Google a été fermée avant la fin",
    storageBlocked:
      "Ce navigateur bloque le stockage de session (cookies/IndexedDB) — autorisez les données de site pour ce domaine afin que la connexion survive à un rechargement.",
    popupBlocked:
      "La fenêtre Google n'a pas pu s'ouvrir (pop-up bloquée ou navigateur mobile) — réessayez",
    unauthorizedDomain:
      "Ce domaine n'est pas autorisé dans Firebase — ajoutez-le aux « Authorized domains » de la console, puis réessayez",
    operationNotSupported:
      "Ce navigateur ne supporte ni la fenêtre popup ni la redirection — essayez un autre navigateur",
    profileSave:
      "Connexion réussie, mais l'enregistrement du profil a échoué — détails dans la console du navigateur",
    network: "Connexion impossible, vérifiez votre réseau",
    unknown: "Une erreur inattendue est survenue, réessayez",
  },
  role: {
    title: "تحديد صفة المستخدم",
    subtitle: "Nous adaptons les recommandations et les alertes à votre activité.",
    hint: "Modifiable à tout moment depuis les réglages.",
    confirm: "Continuer",
    back: "Retour",
    options: {
      farmer: {
        label: "Agriculteur / Exploitant",
        tag: "Terrain",
        description: "Suivez vos parcelles, diagnostiquez les maladies et calculez l'eau d'irrigation.",
        perks: ["Diagnostic par photo", "Calendrier d'irrigation adapté", "Alertes météo et vent"],
      },
      agronomist: {
        label: "Ingénieur agronome / Conseil",
        tag: "Conseil",
        description: "Accompagnez les exploitants avec des données fiables et des rapports partageables.",
        perks: ["Tableau multi-clients", "Rapports NDVI satellite", "Historique exportable"],
      },
      investor: {
        label: "Investisseur / Passionné du secteur",
        tag: "Investissement",
        description: "Suivez les indicateurs du secteur et les opportunités de la filière agricole.",
        perks: ["Indicateurs production et eau", "Cartes des zones prometteuses", "Veille prix des cultures"],
      },
    },
  },
  location: {
    title: "Choix de la wilaya",
    subtitle: "Nous initialisons la météo et les cultures recommandées selon votre zone.",
    search: "Rechercher une wilaya",
    searchPlaceholder: "Nom ou numéro de la wilaya…",
    results: "{n} wilayas",
    empty: "Aucun résultat",
    emptyHint: "Essayez le nom en arabe ou en français, ou le code de la wilaya.",
    selectedLabel: "Wilaya sélectionnée",
    confirm: "Confirmer la wilaya",
    back: "Retour",
    regionLabel: "Région",
    altitudeLabel: "Altitude",
    soilLabel: "Type de sol",
    climateLabel: "Météo de référence",
    cropsLabel: "Cultures principales",
    tempLabel: "Température",
    humidityLabel: "Humidité",
    windLabel: "Vent",
    rainLabel: "Pluie",
    humidity: "{n} %",
    wind: "Vent {n} km/h",
    rain: "Pluie {n} mm/an",
    clear: "Effacer la recherche",
  },
  success: {
    title: "Bienvenue sur Smart Crop AI",
    subtitle: "Votre profil est prêt et le tableau de bord est calé sur vos choix.",
    summaryTitle: "Récapitulatif",
    summaryMethod: "Méthode de connexion",
    summaryRole: "Profil",
    summaryWilaya: "Wilaya",
    cta: "Ouvrir le tableau de bord",
    secondary: "Modifier les choix",
    perks: [
      "Météo et cultures calées sur votre wilaya",
      "Alertes irrigation et vent activées",
      "Données conservées sur cet appareil uniquement",
    ],
  },
  back: "Retour",
  cancel: "Annuler",
  retry: "Réessayer",
};

export const AUTH: Record<Lang, AuthCopy> = { ar: AR, fr: FR };

/** `{name}` / `{n}` placeholders → values. Unknown keys are left untouched. */
export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}
