import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type { ClaudeSetup } from "./setup";

/** While `claude auth login` runs: the code its browser page may show to
 * paste back. Not a form: it sits inside agent creation's and Settings' own. */
export function SignInCode({ setup }: { setup: ClaudeSetup }) {
  const [code, setCode] = useState("");
  const send = () => {
    if (!code.trim()) return;
    void setup.answer(code.trim());
    setCode("");
  };
  return (
    <Field
      label="Sign-in code"
      description="If the browser shows a code to paste, enter it here."
    >
      <div className="flex items-center gap-2">
        <Input
          value={code}
          onValueChange={setCode}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
        />
        <Button type="button" disabled={!code.trim()} onClick={send}>
          Send
        </Button>
      </div>
    </Field>
  );
}
