// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { type PendingApproval } from "@deepseek-ai/dsh-client-ui-approval/client";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useState } from "react";
import { type ContainerPluginKey } from "./locales.js";

// The reserved tool-name prefix for prompts this plugin raises about built-in
// operations. The panel takes over the composer for those only, so the
// harness's own approvals keep its labels.
export const BUILTIN_PROMPT_PREFIX = "dsh_podman_builtin_";

export function ReadOnlyApprovalPanel(props: {
  t: (key: ContainerPluginKey) => string;
  matched: PendingApproval;
}): ReactNode {
  // Keying the flow on the request remounts it for each new prompt, so the
  // answered state never leaks between prompts.
  return <ReadOnlyApprovalFlow key={props.matched.key} {...props} />;
}

function ReadOnlyApprovalFlow({
  t,
  matched,
}: {
  t: (key: ContainerPluginKey) => string;
  matched: PendingApproval;
}): ReactNode {
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState("");
  const answer = (outcome: "allowed-once" | "rejected"): void => {
    setAnswered(true);
    setError("");
    void matched.answer(outcome).catch((failure: unknown) => {
      setAnswered(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "8px calc(var(--dsh-composer-side-clearance) + 16px) 12px",
      }}
    >
      <div
        style={{
          overflow: "hidden",
          width: "100%",
          maxWidth: "var(--dsh-chat-content-width)",
          border: "1px solid var(--dsw-alias-state-warn-secondary)",
          borderRadius: "20px",
          background: "var(--dsw-specific-input-major)",
          boxShadow: "var(--dsw-shadow-lv2)",
        }}
      >
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 16px",
            background: "var(--dsw-alias-state-warn-tertiary)",
            color: "var(--dsw-alias-state-warn-primary)",
            fontSize: "13px",
            lineHeight: "18px",
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: "var(--dsw-alias-state-warn-primary)",
            }}
          />
          {t("remountWaiting")}
        </div>
        <div
          style={{
            boxSizing: "border-box",
            maxHeight: "var(--dsh-composer-text-max-height)",
            overflowY: "auto",
            padding: "12px 16px 0",
          }}
        >
          <div
            style={{
              color: "var(--dsw-alias-label-primary)",
              fontSize: "15px",
              fontWeight: 500,
              lineHeight: "24px",
              whiteSpace: "pre-line",
            }}
          >
            {matched.reason ?? ""}
          </div>
        </div>
        {error === "" ? null : (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: "8px 16px 0",
              fontSize: "13px",
              color: "var(--dsw-alias-state-error-primary)",
            }}
          >
            {error}
          </p>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            padding: "14px 16px",
          }}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={answered}
            onClick={() => answer("rejected")}
          >
            {t("remountReject")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={answered}
            onClick={() => answer("allowed-once")}
          >
            {t("remountApprove")}
          </Button>
        </div>
      </div>
    </div>
  );
}
