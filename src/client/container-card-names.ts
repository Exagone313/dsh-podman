// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The one name rule the storage dialogs enforce: the names a volume or a secret
// may carry, valid from the first character to the last.
export const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

// The name a create form submits: undefined while the field still breaks the
// rule, so a caller can refuse it without repeating the expression, and the
// trimmed name the host actually receives once it passes.
export function createdName(raw: string): string | undefined {
  return namePattern.test(raw) ? raw.trim() : undefined;
}
