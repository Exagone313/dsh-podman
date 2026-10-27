// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The card's transient command feedback, hosted in the harness's frame-wide
// overlay layer so a report raised on the settings page stays visible after the
// user navigates away. Load and version problems keep the page banner instead.

import { type ContainerCardFace } from "./container-card-controller.js";
import {
  IconWarningOutlineRegular,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  type InjectFace,
  type PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import { type ReactNode } from "react";

export type ContainerCardToastProps =
  & PropsRuntime<"shell.overlay">
  & InjectFace<ContainerCardFace>;

export function ContainerCardToast(props: ContainerCardToastProps): ReactNode {
  const toast = props.useContainerCard((state) => state.toast);
  if (toast === null) return null;
  return (
    <Toast
      // A new report remounts the banner, which restarts its hold.
      key={`podman-card-toast-${String(toast.seq)}`}
      text={toast.text}
      icon={toast.kind === "ok" ? undefined : <IconWarningOutlineRegular />}
      onDone={props.dismissToast}
    />
  );
}
