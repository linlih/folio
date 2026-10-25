import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useShell } from "./tabs";
import "./dialog.css";

/** A dialog over the app (backups, shortcuts); closing clears the shell's
 *  dialog slot. */
/** `onClose`: the user closed the dialog (Esc, ✕, a click outside), not
 *  merely that it left the screen. */
export function DialogFrame({
  title,
  description,
  children,
  wide = false,
  onClose,
}: {
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const setDialog = useShell((s) => s.setDialog);
  const close = (open: boolean) => {
    if (open) return;
    onClose?.();
    setDialog(null);
  };
  return (
    <Dialog.Root open onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className={`dialog${wide ? " wide" : ""}`}>
          <header className="dialog-header">
            <Dialog.Title className="dialog-title">{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t("dialog.close")}>
              <X size={15} />
            </Dialog.Close>
          </header>
          <Dialog.Description className="dialog-description">{description}</Dialog.Description>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

