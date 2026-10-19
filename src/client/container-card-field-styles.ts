// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";

// The class on the wrapper of a shared row's value-slot text control: a
// read-only field's Input in the container block, or an editable field in an
// editor. The primitive's Input wrapper is an inline-flex box sized by its
// content, so this class lets the control claim the width of the slot it is
// given, with the field's own copy or remove control keeping the rest of the
// line. A select carries the same slot sizing through slotSelect
// (container-card-styles.ts).
export const SLOT_CLASS = "dsh-podman-slot-control";

// The extra class on a read-only field, which reads its value on the body scale
// instead of the control scale and sits on the module platform's own tint with
// a lighter stroke than an editable field. A lock drawn inline leads the value
// (container-card-shared.tsx), so the tint, the muted text and the glyph mark it
// as fixed before it is clicked, while an editable field keeps the card's plain
// surface and its business-blue focus ring.
export const FIELD_CLASS = "dsh-podman-readonly-field";

// The extra class on a value-slot control that holds a conflicting variable
// name — empty, or used twice: the wrapper's own stroke turns to the error state
// colour, so the row's key reads as the one to fix. It covers the focused state
// too, whose business stroke the primitive would otherwise give the wrapper.
export const SLOT_INVALID_CLASS = "dsh-podman-slot-invalid";

export const FIELD_STYLES = `
.dsh-podman-slot-control {
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
}
.dsh-podman-slot-invalid,
.dsh-podman-slot-invalid:focus-within {
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-podman-readonly-field {
  background: var(--dsw-alias-bg-module-platform);
  border-color: var(--dsw-alias-border-l3);
}
/* A fixed value takes no focus ring: nothing changes when it is focused, so its
   own lighter stroke stays put instead of the primitive's business-blue one. */
.dsh-podman-readonly-field:focus-within {
  border-color: var(--dsw-alias-border-l3);
}
.dsh-podman-readonly-field input {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
`;

/** Inject the value slot's stylesheet for the owning plugin lifetime. */
export function installFieldStyles(ctx: ClientContext): void {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@exagone313/dsh-podman";
    tag.textContent = FIELD_STYLES;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "podman: field styles");
}
