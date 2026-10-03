/**
 * Bilingual copy for the conversation sidebar (drawer) + loading state.
 * Same shape-first convention as `lib/assistant/copy.ts` — kept as its own
 * module so the existing assistant copy contract is never touched.
 */

import type { Lang } from "@/lib/wilayas";

export interface HistoryCopy {
  /** Opens the drawer. */
  menu: string;
  /** Closes the drawer. */
  close: string;
  newChat: string;
  drawerTitle: string;
  groups: {
    today: string;
    yesterday: string;
    week: string;
    older: string;
  };
  emptyList: string;
  itemMenu: string;
  rename: string;
  renamePlaceholder: string;
  renameSave: string;
  renameCancel: string;
  deleteOne: string;
  deleteOneConfirm: string;
  deleteAll: string;
  deleteAllConfirm: string;
  savedToAccount: string;
  savedOnDevice: string;
  loading: string;
}

const AR: HistoryCopy = {
  menu: "القائمة",
  close: "إغلاق",
  newChat: "محادثة جديدة",
  drawerTitle: "المحادثات",
  groups: {
    today: "اليوم",
    yesterday: "أمس",
    week: "آخر 7 أيام",
    older: "أقدم",
  },
  emptyList: "لا توجد محادثات بعد.",
  itemMenu: "خيارات المحادثة",
  rename: "إعادة تسمية",
  renamePlaceholder: "اسم المحادثة",
  renameSave: "حفظ",
  renameCancel: "إلغاء",
  deleteOne: "حذف",
  deleteOneConfirm: "هل تريد حذف هذه المحادثة؟ لا يمكن التراجع عن هذا الإجراء.",
  deleteAll: "حذف كل المحادثات",
  deleteAllConfirm: "هل تريد حذف كل المحادثات؟ لا يمكن التراجع عن هذا الإجراء.",
  savedToAccount: "تُحفظ المحادثات في حسابك",
  savedOnDevice: "تُحفظ على هذا الجهاز",
  loading: "جارٍ تحميل المحادثة…",
};

const FR: HistoryCopy = {
  menu: "Menu",
  close: "Fermer",
  newChat: "Nouvelle conversation",
  drawerTitle: "Conversations",
  groups: {
    today: "Aujourd'hui",
    yesterday: "Hier",
    week: "7 derniers jours",
    older: "Plus ancien",
  },
  emptyList: "Aucune conversation pour le moment.",
  itemMenu: "Options de la conversation",
  rename: "Renommer",
  renamePlaceholder: "Nom de la conversation",
  renameSave: "Enregistrer",
  renameCancel: "Annuler",
  deleteOne: "Supprimer",
  deleteOneConfirm: "Supprimer cette conversation ? Cette action est irréversible.",
  deleteAll: "Supprimer toutes les conversations",
  deleteAllConfirm: "Supprimer toutes les conversations ? Cette action est irréversible.",
  savedToAccount: "Les conversations sont enregistrées dans votre compte",
  savedOnDevice: "Enregistrées sur cet appareil",
  loading: "Chargement de la conversation…",
};

export const HISTORY_COPY: Record<Lang, HistoryCopy> = { ar: AR, fr: FR };
