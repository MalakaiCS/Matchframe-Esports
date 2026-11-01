import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { describeError } from "../api/index.ts";
import { useUnsavedGuard } from "../lib/unsaved.ts";
import type { UnsavedGuard } from "../lib/unsaved.ts";
import { Link, navigate } from "../router.tsx";
import { useToast } from "./toasts.tsx";
import { Button, Modal } from "./ui.tsx";

export interface Editor {
  saving: boolean;
  saveError: string | null;
  setSaveError: (e: string | null) => void;
  guard: UnsavedGuard;
  /** Save and Exit: saves once (repeat clicks while saving are ignored), then returns to the list. */
  saveAndExit: () => void;
  /** Cancel: asks first when something changed, then discards and returns to the list. */
  cancel: () => void;
  /** Leaves to another page, offering to save first when something changed. */
  leaveTo: (path: string) => void;
}

/**
 * Save/leave behaviour shared by the record editors. `save` throws to keep the person on the
 * form (their values stay; the error is shown); `onDiscard` cleans up (staged uploads).
 */
export function useEditor({ dirty, backTo, save, onDiscard, savedMessage }: { dirty: boolean; backTo: string; save: () => Promise<void>; onDiscard?: () => void; savedMessage?: () => string | null }): Editor & { dialog: ReactNode } {
  const guard = useUnsavedGuard(dirty);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const toast = useToast();

  const runSave = useCallback(
    async (then: () => void) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSaving(true);
      setSaveError(null);
      try {
        await save();
        guard.release();
        const msg = savedMessage?.();
        if (msg) toast.push("ok", msg);
        then();
      } catch (e) {
        setSaveError(describeError(e));
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    },
    [save, guard, savedMessage, toast],
  );

  const saveAndExit = useCallback(() => void runSave(() => navigate(backTo, false, { force: true })), [runSave, backTo]);
  const cancel = useCallback(
    () =>
      guard.ask(() => {
        onDiscard?.();
        navigate(backTo, false, { force: true });
      }),
    [guard, onDiscard, backTo],
  );
  const leaveTo = useCallback((path: string) => guard.ask(() => navigate(path, false, { force: true })), [guard]);

  const dialog = guard.pending ? (
    <Modal
      title="Discard unsaved changes?"
      onClose={guard.keepEditing}
      footer={
        <>
          <Button onClick={guard.keepEditing}>Keep editing</Button>
          <Button
            variant="danger"
            onClick={() => {
              onDiscard?.();
              guard.discard();
            }}
          >
            Discard changes
          </Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              const go = guard.pending;
              guard.keepEditing();
              void runSave(() => go?.());
            }}
          >
            Save and continue
          </Button>
        </>
      }
    >
      <p>You have changes on this page that are not saved. Save them, discard them, or keep editing.</p>
    </Modal>
  ) : null;

  return { saving, saveError, setSaveError, guard, saveAndExit, cancel, leaveTo, dialog };
}

/**
 * Dedicated create/edit screen inside the console's content area: title with a back link and
 * breadcrumb, the form, and a footer that stays in view with Cancel and Save and Exit.
 */
export function EditorShell({ title, subtitle, backTo, backLabel, crumbs, editor, children, saveDisabledReason, footerNote }: { title: ReactNode; subtitle?: ReactNode; backTo: string; backLabel: string; crumbs: string[]; editor: Editor & { dialog: ReactNode }; children: ReactNode; saveDisabledReason?: string | null; footerNote?: ReactNode }) {
  return (
    <div className="page editor-page">
      <header className="editor-head">
        <nav className="editor-crumbs" aria-label="Breadcrumb">
          <Link
            to={backTo}
            className="editor-back"
            onClick={(e) => {
              e.preventDefault();
              editor.cancel();
            }}
          >
            ← {backLabel}
          </Link>
          {crumbs.map((c, i) => (
            <span key={i} className="editor-crumb">
              <span aria-hidden> / </span>
              {c}
            </span>
          ))}
        </nav>
        <h1 className="editor-title">{title}</h1>
        {subtitle ? <div className="editor-subtitle">{subtitle}</div> : null}
      </header>
      {/* Not a <form>: Enter in a field (or in the sections applied at once) never saves by accident. */}
      <div className="editor-form">
        <div className="editor-body">{children}</div>
        <footer className="editor-foot">
          <div className="editor-foot-msg" aria-live="polite">
            {editor.saveError ? (
              <span className="ff-error" role="alert">
                Not saved: {editor.saveError}
              </span>
            ) : (
              footerNote
            )}
          </div>
          <Button onClick={editor.cancel} disabled={editor.saving}>
            Cancel
          </Button>
          <Button variant="primary" disabled={editor.saving} disabledReason={saveDisabledReason ?? null} aria-busy={editor.saving} onClick={editor.saveAndExit}>
            {editor.saving ? <span className="spinner" aria-hidden /> : null}
            {editor.saving ? "Saving…" : "Save and Exit"}
          </Button>
        </footer>
      </div>
      {editor.dialog}
    </div>
  );
}
