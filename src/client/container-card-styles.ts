// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

export const cardStyle: React.CSSProperties = {
  listStyle: "none",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: "12px",
  background: "var(--dsw-alias-bg-layer-3)",
  transition: "border-color .16s, background .16s",
};

export const cardOpenStyle: React.CSSProperties = {
  background: "var(--dsw-alias-bg-layer-2)",
  borderColor: "var(--dsw-alias-label-dimmed)",
};

export const cardHoverStyle: React.CSSProperties = {
  borderColor: "var(--dsw-alias-label-dimmed)",
};

export const cardHeaderStyle: React.CSSProperties = {
  width: "100%",
  appearance: "none",
  border: 0,
  background: "none",
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "14px 16px",
  borderRadius: "12px",
};

export const cardHeadTextStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

export const cardNameStyle: React.CSSProperties = {
  fontSize: "15px",
  fontWeight: 600,
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-primary)",
};

export const cardDescriptionStyle: React.CSSProperties = {
  fontSize: "13px",
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-tertiary)",
};

export const cardBodyStyle: React.CSSProperties = {
  borderTop: "1px solid var(--dsw-alias-border-l2)",
  margin: "0 16px",
  paddingBottom: "8px",
};

export const sectionTitle: React.CSSProperties = {
  fontWeight: 600,
  margin: "16px 0 8px",
  fontSize: "13px",
  color: "var(--dsw-alias-label-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

export const banner: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid rgba(210,153,34,0.6)",
  margin: "12px 0",
  fontSize: "13px",
};

export const greyId: React.CSSProperties = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "12px",
  fontFamily: "var(--dsw-alias-font-mono, ui-monospace, monospace)",
};

export const hint: React.CSSProperties = {
  fontSize: "13px",
  color: "var(--dsw-alias-label-tertiary)",
  margin: "8px 0",
};

export const wsBody: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "10px 0 12px",
};

export const containerRow: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "10px 12px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: "10px",
  background: "var(--dsw-alias-bg-layer-3)",
};

export const containerHeader: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
};

export const actions: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  alignItems: "center",
};

export const footerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  paddingTop: "12px",
  marginTop: "12px",
  borderTop: "1px solid var(--dsw-alias-border-l2)",
};

export const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

export const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  borderBottom: "1px solid var(--dsw-alias-border-l2)",
  color: "var(--dsw-alias-label-secondary)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

export const tdStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid var(--dsw-alias-border-l2)",
  color: "var(--dsw-alias-label-primary)",
  verticalAlign: "top",
};

export const imageSelect: React.CSSProperties = {
  appearance: "none",
  padding: "4px 8px",
  borderRadius: "8px",
  border: "1px solid var(--dsw-alias-border-l2)",
  background: "var(--dsw-alias-bg-layer-3)",
  color: "inherit",
  fontSize: "12px",
  maxWidth: "160px",
};
