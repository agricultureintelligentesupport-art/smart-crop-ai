import { redirect } from "next/navigation";

/**
 * Guest mode was removed: every dashboard feature now requires an
 * authenticated account (Google, phone or e-mail). Old `/guest` links and
 * bookmarks are forwarded straight to the auth wizard.
 */
export default function GuestPage() {
  redirect("/auth");
}
