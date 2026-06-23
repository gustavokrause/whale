"use client";

// Imperative replacement for the browser's native confirm()/prompt(). Mounted
// once at app root; `useDialog()` hands back promise-returning helpers so call
// sites read almost like the native ones — `await dlg.confirm({...})`.
import * as React from "react";
import { Dialog, DialogContent, DialogFooter } from "./dialog";
import { Button, type ButtonProps } from "./button";

type Variant = NonNullable<ButtonProps["variant"]>;

type ConfirmOpts = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: Variant;
};

type PromptOpts = {
  title: string;
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
};

type Ctx = {
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  prompt: (o: PromptOpts) => Promise<string | null>;
};

const DialogCtx = React.createContext<Ctx | null>(null);

type State =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | null;

const fieldCls =
  "w-full px-3 py-2.5 bg-surface text-text border border-border-strong rounded-lg font-mono text-sm focus:outline-none focus:border-primary";

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<State>(null);
  const [value, setValue] = React.useState("");

  const confirm = React.useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => setState({ kind: "confirm", opts, resolve })),
    [],
  );
  const prompt = React.useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? "");
        setState({ kind: "prompt", opts, resolve });
      }),
    [],
  );

  // Resolve the pending promise, then unmount the dialog.
  const finish = (result: boolean | string | null) => {
    setState((s) => {
      if (s) s.resolve(result as never);
      return null;
    });
  };
  const cancel = () => finish(state?.kind === "prompt" ? null : false);
  const accept = () => finish(state?.kind === "prompt" ? value : true);

  const ctx = React.useMemo(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <DialogCtx.Provider value={ctx}>
      {children}
      <Dialog open={state !== null} onOpenChange={(o) => !o && cancel()}>
        {state && (
          <DialogContent title={state.opts.title} description={state.opts.description}>
            {state.kind === "prompt" && (
              <div className="px-6 pt-5">
                {state.opts.multiline ? (
                  <textarea
                    autoFocus
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && accept()}
                    placeholder={state.opts.placeholder}
                    className={`${fieldCls} min-h-[120px]`}
                  />
                ) : (
                  <input
                    autoFocus
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && accept()}
                    placeholder={state.opts.placeholder}
                    className={fieldCls}
                  />
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="neutral" onClick={cancel}>
                {state.opts.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={state.kind === "confirm" ? state.opts.confirmVariant ?? "primary" : "primary"}
                onClick={accept}
              >
                {state.opts.confirmLabel ?? (state.kind === "confirm" ? "Confirm" : "OK")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </DialogCtx.Provider>
  );
}

export function useDialog() {
  const ctx = React.useContext(DialogCtx);
  if (!ctx) throw new Error("useDialog must be inside <DialogProvider>");
  return ctx;
}
