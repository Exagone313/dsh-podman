// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Load template flow, split into two popups. The picker only chooses one of
// the project's templates (or an uploaded YAML file) and lists; the details
// popup then explains what the template will stage, carries the image state and
// builds or rebuilds the image when the user clicks the image card's action.
// Only after that does Continue hand a prefilled draft to the create or edit
// editor. Nothing is built, created, saved or written without an explicit
// click.

import { type ContainerConfig } from "./container-card-config.js";
import type {
  ContainerView,
  ImageView,
  WorkspaceView,
} from "./container-card-controller.js";
import type {
  TemplateApplyView,
  TemplateEntryView,
  TemplateInspectionView,
  TemplatePublishView,
} from "./template-protocol.js";
import { EnvEditor, MountsEditor } from "./container-card-editors.js";
import { PathsEditor } from "./container-card-paths.js";
import { PortsEditor } from "./container-card-ports.js";
import { SecretEnvEditor, SecretModal } from "./container-card-secrets.js";
import { CreateVolumeModal } from "./container-card-create-volume.js";
import { DirectoryPickerModal } from "./container-card-directory.js";
import type { DirectoryPickerFace } from "./directory-picker.js";
import {
  TEMPLATE_DIALOG_CLASS,
  TEMPLATE_DIALOG_CONTENT_CLASS,
} from "./container-card-dialog-styles.js";
import { ImageFacts } from "./image-facts.js";
import { Chip, DialogGroup, ImageRow } from "./container-card-shared.js";
import { ROW_LIST_CLASS } from "./container-card-table-styles.js";
import {
  type TemplateBlockReason,
  templateBlockReason,
  templateChoiceActionable,
  templateConfigForEditor,
  templateDisplayName,
  templateDraftImageFacts,
  templateDraftMissingReferences,
  type TemplateDraftReference,
  templateDraftReferences,
  type TemplateEditorConfig,
  templateImageAction,
  type TemplateImageActionDecision,
  templateImageCandidates,
  type TemplateProjectCheck,
  templateProjectChecksEqual,
  templateProjectPathDecision,
  templateProjectPathError,
  type TemplateSource,
  type TemplateSpecSummary,
  templateSpecSummary,
  templateSummaryAccessibleLabel,
  templateSummaryLineText,
  templateSummarySegments,
} from "./container-template-ui.js";
import {
  blockFields,
  businessAction,
  fieldGroup,
  fieldGroupLabel,
  hint,
  missingValue,
  rowMeta,
  rowName,
  templateAction,
  templateActionSelected,
} from "./container-card-styles.js";
import {
  decideProjectPath,
  hostPathForProjectName,
  projectNameFromHostPath,
} from "../project-path.js";
import { type Translate } from "./locales.js";
import {
  Button,
  IconCheckOutlineRegular,
  Input,
  Modal,
  SegmentedControl,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export interface TemplateActions {
  listTemplates: (
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<TemplateEntryView[]>;
  inspectTemplate: (
    request: { op: "inspect"; workspace: string; name: string; yaml?: string },
    signal?: AbortSignal,
  ) => Promise<TemplateInspectionView>;
  buildTemplate: (
    request: {
      op: "build";
      workspace: string;
      name: string;
      yaml?: string;
      force?: boolean;
    },
    signal?: AbortSignal,
  ) => Promise<TemplateInspectionView & { built: boolean }>;
  applyTemplate: (
    request: {
      op: "apply";
      workspace: string;
      name: string;
      yaml?: string;
      container?: string;
    },
    signal?: AbortSignal,
  ) => Promise<TemplateApplyView>;
  publishTemplate: (
    request: {
      op: "publish";
      workspace: string;
      name: string;
      yaml?: string;
      container: string;
    },
    signal?: AbortSignal,
  ) => Promise<TemplatePublishView>;
}

// The one template the picker hands to the details popup: the project file's
// name and its document (the uploaded file's own name and content).
export interface TemplateSelection {
  name: string;
  yaml: string;
}

// What Continue hands the editor, kept so the editor's Back can reopen the
// details popup exactly as the user left it: the template selection, the draft
// that was passed on, and the destination choice with its replace target and
// filter. The editor's own edits are never part of it.
export interface TemplateResume {
  selection: TemplateSelection;
  draft: TemplateEditorConfig;
  mode: "create" | "replace";
  replaceTarget: string;
  replaceFilter: string;
}

// The error line a popup shows for a failed read or build.
const errorText: CSSProperties = {
  margin: 0,
  color: "var(--dsw-alias-state-error)",
};

// The column the details popup stacks its header, summary and sections in. The
// gap is what separates the blocks; each section paints its own surface.
const detailsBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

// The details popup's header: the file name under the template name the Modal
// title already carries, then the destination choice at the top of the flow.
const detailsHeader: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

// The template's file name: muted beneath its name, never a section title.
const detailsFile: CSSProperties = {
  ...rowMeta,
  margin: 0,
};

// The destination choice and the line that explains where Continue will go.
const destinationBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "6px",
};

// The one line under the destination control: Create names the next step, and
// Replace's own list names the target.
const destinationHint: CSSProperties = {
  ...hint,
  margin: 0,
};

// The details popup's footer: the reason slot on the left, the actions
// right-aligned. The slot is always rendered, so the actions keep their place
// whether or not a reason is present.
const footerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
};

// The details popup's reason slot: a blocking reason explains why Continue is
// disabled. It lives in the sticky footer, not in the scrolling body, so it
// stays visible while the sections scroll.
const footerReason: CSSProperties = {
  flex: "1 1 auto",
  minHeight: "18px",
  fontSize: "12px",
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-tertiary)",
  textAlign: "left",
};

// A blocking reason, in the harness's error colour — the one mount errors use.
const footerReasonError: CSSProperties = {
  ...footerReason,
  color: "var(--dsw-alias-state-error-primary)",
};

const footerActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flex: "none",
};

// The replace target's column: the filter above the bounded list of choices.
const replaceBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  width: "100%",
};

// The bounded list of containers a replace can target: a workspace with many
// containers scrolls this list instead of the whole dialog, and each row is the
// picker's full-width outlined control.
const replaceList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  maxHeight: "180px",
  overflowY: "auto",
  scrollbarGutter: "stable",
  padding: "2px",
};

// The picker's choices: one column, each row a full-width control.
const choiceList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

// The text column of a picker row: the template's name over its one metadata
// line, both starting at the row's left edge.
const choiceText: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  minWidth: 0,
  flex: "1 1 auto",
};

// A picker row's name line.
const choiceName: CSSProperties = {
  ...rowName,
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: "20px",
  color: "var(--dsw-alias-label-primary)",
};

// A picker row's name line when it also carries a chip: the name, then the
// badge that marks an uploaded file.
const choiceNameRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  minWidth: 0,
};

// A one-line secondary value that truncates rather than wrapping, so a replace
// option keeps the same two-line shape whatever image id it names.
const choiceMeta: CSSProperties = {
  ...rowMeta,
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  lineHeight: "18px",
};

// A picker row's facts line: every category in one wrapping line. It never
// truncates or nowrap-clips a value; the button's own height grows with the
// lines the facts need, so long names stay whole and rows take their own height.
const choiceFacts: CSSProperties = {
  ...rowMeta,
  lineHeight: "18px",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
};

// The error block an invalid file shows in the metadata slot: the harness's
// error tone on a soft tint, wrapping over as many lines as the parser's reason
// needs so nothing the user can act on is hidden.
const choiceInvalid: CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "100%",
  padding: "0 8px",
  borderRadius: "6px",
  fontSize: "12px",
  fontWeight: 500,
  lineHeight: "20px",
  color: "var(--dsw-alias-state-error-primary)",
  background:
    "color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

// The metrics shared by every choice row in either popup: a full-width outlined
// control whose first line is top-aligned with the selection check, and whose
// whole box — not just the text — is what hover and focus outline.
const choiceMetrics: CSSProperties = {
  width: "100%",
  height: "auto",
  padding: "10px 12px",
  alignItems: "flex-start",
  justifyContent: "flex-start",
  textAlign: "left",
  whiteSpace: "normal",
};

// A picker row: the harness's outlined control, stretched to hold as many lines
// as its facts need, painted with the shared violet when it is the current
// choice.
function choiceStyle(selected: boolean): CSSProperties {
  return {
    ...choiceMetrics,
    ...(selected ? templateActionSelected : {}),
  };
}

// A replace row: the same outlined control, painted with the business blue when
// it is the chosen container, so the target reads like the Recreate action
// rather than the templates' violet accent.
function replaceChoiceStyle(selected: boolean): CSSProperties {
  return {
    ...choiceMetrics,
    ...(selected ? businessAction : {}),
  };
}

// The upload control under the picker's list: its label names the action and
// the native file input below it is what the browser draws.
const uploadField: CSSProperties = {
  ...fieldGroup,
  ...fieldGroupLabel,
  whiteSpace: "normal",
  textAlign: "left",
  cursor: "pointer",
};

// The description slot of one picker row, for a project template and an upload
// alike: the parsed template's labelled facts in full, or the parser's full
// reason in a wrapping error block when the file does not parse. There is no
// tooltip: nothing is hidden to repeat, and both lines wrap instead of
// truncating.
function PickerDescription(props: {
  t: Translate;
  summary: TemplateSpecSummary | undefined;
}): ReactNode {
  const { t, summary } = props;
  if (summary === undefined) return null;
  if (!summary.valid) {
    return <span style={choiceInvalid}>{summary.reason}</span>;
  }
  return (
    <span style={choiceFacts}>
      {templateSummaryLineText(templateSummarySegments(t, summary))}
    </span>
  );
}

// blockingReasonText is the one line that says why Continue is disabled. It
// never restates a state another part of the popup already carries: the loading
// hint and the image card (with a build failure's own message) report
// themselves. Every line it returns is a blocking reason, so the footer paints
// it in the error colour and announces it as an alert.
function blockingReasonText(
  t: Translate,
  block: TemplateBlockReason | undefined,
  building: boolean,
  missingReferences: number,
): string | undefined {
  switch (block) {
    case "build":
      return building ? undefined : t("templateBuildRequired");
    case "image-missing":
      return t("templateImageMissing");
    case "checking":
      return t("templateCheckingReferences");
    case "missing-references":
      return missingReferences === 1
        ? t("templateReferenceMissingOne")
        : t("templateReferenceMissingMany", { n: String(missingReferences) });
    case "no-container":
      return t("templateNoContainer");
    default:
      return undefined;
  }
}

// TemplatePickerModal is the first popup: it lists the project's templates and
// offers an upload. Choosing one only changes this popup's selection; Next is
// the explicit step that opens the details popup, and nothing is inspected,
// built or created here.
function TemplatePickerModal(props: {
  t: Translate;
  open: boolean;
  workspace: WorkspaceView;
  busy: boolean;
  actions: TemplateActions;
  onClose: () => void;
  onChoose: (selection: TemplateSelection) => void;
}): ReactNode {
  const { t, open, workspace, busy, actions, onClose, onChoose } = props;
  const [entries, setEntries] = useState<TemplateEntryView[] | null>(null);
  const [selected, setSelected] = useState("");
  const [upload, setUpload] = useState<TemplateSelection | null>(null);
  const [error, setError] = useState("");
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Opening lists the project's templates and resets the choice. It never
  // preselects an entry: the user's own choice is the point of this step.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setEntries(null);
    setSelected("");
    setUpload(null);
    setError("");
    void actionsRef.current.listTemplates(
      workspace.workspaceSlug,
      controller.signal,
    ).then(
      (listed) => {
        if (controller.signal.aborted) return;
        setEntries(listed);
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setEntries([]);
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => controller.abort();
  }, [open, workspace.workspaceSlug]);

  const selectedEntry = entries?.find((entry) => entry.name === selected);
  const choice: TemplateSelection | undefined = upload ?? selectedEntry;
  // Each row's description, and the uploaded file's: what the parsed template
  // does, never a guess at its image or a re-read of its file name. Parsing is
  // local and read-only, so listing never calls the host more than once.
  const summaries = useMemo(() => {
    const map = new Map<string, TemplateSpecSummary>();
    for (const entry of entries ?? []) {
      map.set(entry.name, templateSpecSummary(entry.yaml));
    }
    return map;
  }, [entries]);
  const uploadSummary = useMemo(
    () => (upload === null ? undefined : templateSpecSummary(upload.yaml)),
    [upload],
  );
  // The summary Next acts on: the upload's own parse when it is the choice, the
  // selected project entry's otherwise. A choice without a summary stays
  // disabled, so Next never opens details for a file the picker could not read.
  const choiceSummary: TemplateSpecSummary | undefined = upload !== null
    ? uploadSummary
    : selectedEntry === undefined
    ? undefined
    : summaries.get(selectedEntry.name);
  const nextEnabled = templateChoiceActionable(choiceSummary, busy);
  // The footer carries only the actions. The disabled Next's reason is the row's
  // own wrapping error block — the one explanation — so it is never repeated
  // here; no choice and a missing summary are defensively disabled silently.
  const footer = (
    <div style={footerActions}>
      <Button variant="outline" size="sm" onClick={onClose}>
        {t("cancel")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        style={templateAction}
        disabled={!nextEnabled}
        onClick={() => {
          if (!templateChoiceActionable(choiceSummary, busy)) return;
          if (choice === undefined) return;
          onChoose({
            name: choice.name,
            yaml: choice.yaml,
          });
        }}
      >
        {t("templateNext")}
      </Button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("loadTemplate")}
      description={t("templatePickHint")}
      closeLabel={t("cancel")}
      className={TEMPLATE_DIALOG_CLASS}
      contentClassName={TEMPLATE_DIALOG_CONTENT_CLASS}
      footer={footer}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {error === "" ? null : (
          <p role="alert" style={errorText}>
            {error}
          </p>
        )}
        {entries === null
          ? <p style={hint} role="status">{t("templateLoading")}</p>
          : entries.length === 0 && upload === null
          ? <p style={hint}>{t("templateNone")}</p>
          : (
            <div
              role="group"
              aria-label={t("templateChoose")}
              style={choiceList}
            >
              {entries.map((entry) => {
                const isSelected = upload === null && selected === entry.name;
                return (
                  <Button
                    key={entry.name}
                    variant="outline"
                    size="md"
                    title={entry.name}
                    aria-label={templateSummaryAccessibleLabel(
                      t,
                      templateDisplayName(entry.name),
                      summaries.get(entry.name),
                    )}
                    aria-pressed={isSelected}
                    style={choiceStyle(isSelected)}
                    onClick={() => {
                      setUpload(null);
                      setSelected(entry.name);
                    }}
                  >
                    <span style={choiceText}>
                      <span style={choiceName}>
                        {templateDisplayName(entry.name)}
                      </span>
                      <PickerDescription
                        t={t}
                        summary={summaries.get(entry.name)}
                      />
                    </span>
                    {isSelected ? <IconCheckOutlineRegular size={16} /> : null}
                  </Button>
                );
              })}
              {upload === null ? null : (
                <Button
                  variant="outline"
                  size="md"
                  title={upload.name}
                  aria-label={templateSummaryAccessibleLabel(
                    t,
                    templateDisplayName(upload.name),
                    uploadSummary,
                  )}
                  aria-pressed={true}
                  style={choiceStyle(true)}
                  onClick={() => setSelected("")}
                >
                  <span style={choiceText}>
                    <span style={choiceNameRow}>
                      <span style={choiceName}>
                        {templateDisplayName(upload.name)}
                      </span>
                      <Chip t={t} label={t("templateUploadChip")} />
                    </span>
                    <PickerDescription t={t} summary={uploadSummary} />
                  </span>
                  <IconCheckOutlineRegular size={16} />
                </Button>
              )}
            </div>
          )}
        <label style={uploadField}>
          {t("templateUpload")}
          <input
            type="file"
            accept=".yml,.yaml,application/yaml,text/yaml"
            disabled={busy}
            style={{ marginTop: "6px" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file === undefined) return;
              void file.text().then((yaml) => {
                setSelected("");
                setUpload({ name: file.name, yaml });
              });
            }}
          />
        </label>
      </div>
    </Modal>
  );
}

// TemplateDetailsModal is the second popup: it edits what the chosen template
// will stage, whether its image exists or needs building, and the destination
// choice. The draft is seeded from the template and every group is bound to it
// through the container editor's own components; Build is a deliberate action
// here, and Continue only opens the prefilled editor once the image is ready
// and every reference exists. Nothing is created from this popup.
function TemplateDetailsModal(props: {
  t: Translate;
  // The plugin's active locale, for the build time's relative wording.
  locale: string;
  open: boolean;
  workspace: WorkspaceView;
  containers: readonly ContainerView[];
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  defaultEnv: Record<string, string>;
  // The projects root a project mount's destination is derived from.
  projectsRoot: string;
  // The host directory picker the project references are checked through;
  // absent in deployments that mount none, which keeps the lexical answer.
  directoryPicker?: DirectoryPickerFace;
  busy: boolean;
  writable: boolean;
  // Whether the snapshot knows the port-publishing gateway is missing or
  // incompatible, so the ports group says so instead of staging an unpublishable
  // port.
  gatewayUnavailable: boolean;
  actions: TemplateActions;
  // The Images tab's own image controls, shared so the card's action for an
  // image other than the template's dispatches the same commands.
  onBuildImage: (imageId: string, parent: string, packages: string[]) => void;
  onRebuildImage: (imageId: string) => void;
  onRebuildBaseImage: (name: string) => void;
  onPullBaseImage: (name: string) => void;
  onCreateSecret: (
    name: string,
    length?: number,
    charset?: string,
  ) => Promise<boolean>;
  createVolume: (name: string) => Promise<boolean>;
  onReload: () => void;
  selection: TemplateSelection | null;
  // The state the details popup resumes on after an editor's Back: the draft
  // Continue handed on, and the destination choice the user had made. The
  // template is inspected again either way, so the image state stays current.
  initialDraft?: TemplateEditorConfig;
  initialMode?: "create" | "replace";
  initialReplaceTarget?: string;
  initialReplaceFilter?: string;
  onBack: () => void;
  onClose: () => void;
  // Continue hands the edited draft to the create or edit editor; nothing is
  // saved until that editor's own Apply. A replace also carries the template
  // document, so the host can publish its ports once that Apply succeeded. The
  // resume payload is what the editor's Back comes back to.
  onContinue: (
    mode: "create" | "replace",
    container: string,
    config: ContainerConfig,
    source?: TemplateSource,
    resume?: TemplateResume,
  ) => void;
}): ReactNode {
  const {
    t,
    locale,
    open,
    workspace,
    containers,
    images,
    volumes,
    secrets,
    defaultEnv,
    projectsRoot,
    directoryPicker,
    busy,
    writable,
    gatewayUnavailable,
    actions,
    onBuildImage,
    onRebuildImage,
    onRebuildBaseImage,
    onPullBaseImage,
    onCreateSecret,
    createVolume,
    onReload,
    selection,
    initialDraft,
    initialMode,
    initialReplaceTarget,
    initialReplaceFilter,
    onBack,
    onClose,
    onContinue,
  } = props;
  const [inspection, setInspection] = useState<TemplateInspectionView | null>(
    null,
  );
  // The draft every group edits and Continue hands on. It is seeded when a
  // freshly inspected template arrives and reset when the popup reopens or the
  // selection changes; a later re-read (a build's check) never overwrites it.
  const [draft, setDraft] = useState<TemplateEditorConfig | null>(null);
  const [error, setError] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildFailed, setBuildFailed] = useState("");
  const [mode, setMode] = useState<"create" | "replace">("create");
  const [replaceTarget, setReplaceTarget] = useState(
    containers[0]?.containerName ?? "",
  );
  // The replace list's filter; it is shown only when the workspace holds more
  // containers than the list shows at once.
  const [replaceFilter, setReplaceFilter] = useState("");
  // The project path checks, keyed by the mount's index in the draft.
  const [projectChecks, setProjectChecks] = useState<
    Record<number, TemplateProjectCheck>
  >({});
  // The same map as a ref, so a re-check can tell an answer it already holds
  // from one it still has to ask the host about.
  const projectChecksRef = useRef(projectChecks);
  projectChecksRef.current = projectChecks;
  // The project values the host is listing right now, keyed by the mount's
  // index. It is kept apart from the settled checks, so the answer a row already
  // holds stays stored — and stays readable as its error — while a changed value
  // is checked again.
  const [projectChecksInFlight, setProjectChecksInFlight] = useState<
    Record<number, string>
  >({});
  // The storage dialogs the popup's Create volume / Create secret actions open,
  // and the project row whose row-action Browse is open.
  const [volumeCreateOpen, setVolumeCreateOpen] = useState(false);
  const [secretCreateOpen, setSecretCreateOpen] = useState(false);
  const [projectBrowse, setProjectBrowse] = useState<number | undefined>(
    undefined,
  );
  const destinationId = useId();
  // The popup's host callbacks and the container list arrive as props; a
  // snapshot refresh re-renders the parent, and effect identities must not
  // restart an inspection or reset a draft for that.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const containersRef = useRef(containers);
  containersRef.current = containers;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const defaultEnvRef = useRef(defaultEnv);
  defaultEnvRef.current = defaultEnv;
  const tRef = useRef(t);
  tRef.current = t;
  const pickerRef = useRef(directoryPicker);
  pickerRef.current = directoryPicker;
  const projectsRootRef = useRef(projectsRoot);
  projectsRootRef.current = projectsRoot;
  // A token that invalidates a project check once the draft, the popup or a
  // newer check replaces it.
  const checkToken = useRef(0);

  // Opening on a newly chosen template starts from a clean plan, a clear draft
  // and the Create destination; nothing from a previous choice survives. A
  // resumed open takes the draft and destination the editor's Back came from
  // instead, while the template is still inspected below. Closing also dismisses
  // any storage dialog or directory browser opened on top of it.
  useEffect(() => {
    if (!open) {
      setVolumeCreateOpen(false);
      setSecretCreateOpen(false);
      setProjectBrowse(undefined);
      return;
    }
    checkToken.current += 1;
    setInspection(null);
    setDraft(initialDraft ?? null);
    setError("");
    setBuilding(false);
    setBuildFailed("");
    setMode(initialMode ?? "create");
    setReplaceTarget(
      initialReplaceTarget ?? containersRef.current[0]?.containerName ?? "",
    );
    setReplaceFilter(initialReplaceFilter ?? "");
    setProjectChecks({});
    setProjectChecksInFlight({});
    setVolumeCreateOpen(false);
    setSecretCreateOpen(false);
    setProjectBrowse(undefined);
  }, [
    open,
    selection,
    initialDraft,
    initialMode,
    initialReplaceTarget,
    initialReplaceFilter,
  ]);

  // Inspecting only records the plan (image state, template and id). It never
  // starts a build: that is the Build button's job below. The first plan seeds
  // the draft; a re-read after a build leaves the user's edits alone. A resumed
  // open already holds the draft the editor's Back came from, so the plan only
  // refreshes the image state and never reseeds it.
  useEffect(() => {
    if (!open || selection === null) return;
    const controller = new AbortController();
    setInspection(null);
    setError("");
    setBuildFailed("");
    void actionsRef.current.inspectTemplate(
      {
        op: "inspect",
        workspace: workspace.workspaceSlug,
        name: selection.name,
        yaml: selection.yaml,
      },
      controller.signal,
    ).then(
      (inspected) => {
        if (controller.signal.aborted) return;
        setInspection(inspected);
        setDraft((previous) =>
          previous ??
            templateConfigForEditor(inspected.template, inspected.imageId, {
              defaultEnv: defaultEnvRef.current,
            })
        );
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => controller.abort();
  }, [open, selection, workspace.workspaceSlug]);

  // inspectNow re-reads the template's plan through the host route. The route
  // lists the images when it runs, so the answer is the state at this moment:
  // the popup never derives it from the card's cached image snapshot.
  const inspectNow = async (
    signal?: AbortSignal,
  ): Promise<TemplateInspectionView> => {
    const current = selectionRef.current;
    if (current === null) throw new Error("no template is selected");
    return await actionsRef.current.inspectTemplate(
      {
        op: "inspect",
        workspace: workspace.workspaceSlug,
        name: current.name,
        yaml: current.yaml,
      },
      signal,
    );
  };

  // recheckAfterBuild reads the plan again once a build has finished, whatever
  // its outcome. A failed build, or an image that was removed while the build
  // ran, therefore shows as needing a build instead of leaving the popup on a
  // plan cached when it opened. It never clears the failure message: a failed
  // rebuild leaves the plan ready, and its failure must stay on screen until
  // the user tries again. A re-check that fails itself changes nothing.
  const recheckAfterBuild = async (): Promise<void> => {
    try {
      setInspection(await inspectNow());
    } catch {
      // Keep the build result (or its failure) when the re-check itself fails.
    }
  };

  // The image card's one action. Progress is shown by the button's own busy
  // label; a success replaces the plan with the built image, and a failure
  // leaves its message under the card. `force` is the Rebuild action: it asks
  // the host to rebuild an image the plan already considers current. Continue
  // stays disabled by templateBlockReason while this runs and after a failure.
  // The plan is read again before the busy state ends, so the button and the
  // image state never describe an image that is no longer there.
  const build = async (force: boolean): Promise<void> => {
    if (selection === null || inspection === null || building) return;
    setBuilding(true);
    setBuildFailed("");
    try {
      const built = await actionsRef.current.buildTemplate({
        op: "build",
        workspace: workspace.workspaceSlug,
        name: selection.name,
        yaml: selection.yaml,
        ...(force ? { force: true } : {}),
      });
      setInspection(built);
      onReload();
    } catch (failure) {
      setBuildFailed(
        failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      await recheckAfterBuild();
      setBuilding(false);
    }
  };

  // runImageAction dispatches the image card's one button. The template's own
  // image goes through the template build route, where a Rebuild is the same
  // call with `force`; every other image runs exactly the command the Images
  // tab's own row runs, and the snapshot is refreshed afterwards so the card
  // and its action describe the image the command left behind. Nothing here
  // writes a container: Continue is still the only way to the editor.
  const runImageAction = (decision: TemplateImageActionDecision): void => {
    const current = draftRef.current;
    if (current === null) return;
    const imageId = current.image;
    switch (decision.command) {
      case "template-build":
        void build(false);
        return;
      case "template-rebuild":
        void build(true);
        return;
      case "custom-build": {
        const image = images.find((candidate) => candidate.imageId === imageId);
        if (image === undefined) return;
        onBuildImage(image.imageId, image.parent, [...image.packages]);
        break;
      }
      case "custom-rebuild":
        onRebuildImage(imageId);
        break;
      case "base-build":
      case "base-rebuild":
        onRebuildBaseImage(imageId);
        break;
      case "base-pull":
        onPullBaseImage(imageId);
        break;
      case "none":
        return;
    }
    // The template route re-reads its own plan once the build returns; every
    // other command only asks the card for a fresh snapshot.
    onReload();
  };

  // checkProjects validates every project mount's path the way the mount editor
  // does: lexically first, then by listing the directory through the host
  // picker. It runs only when the popup opens or seeds a draft, when a project
  // field loses focus, and once before Continue — never on a keystroke, so
  // typing performs no host call. Every answer is keyed to the draft it was
  // started for, so a stale listing never marks a newer draft. It reports
  // whether every path is known to exist, which is what Continue waits for.
  const checkProjects = useCallback(async (
    target?: TemplateEditorConfig,
  ): Promise<boolean> => {
    const current = target ?? draftRef.current;
    if (current === null) return true;
    const token = ++checkToken.current;
    const picker = pickerRef.current;
    const root = projectsRootRef.current;
    const next: Record<number, TemplateProjectCheck> = {};
    // The value each row's host check is listing right now, so the row can say
    // it is pending until that answer lands.
    const inFlight: Record<number, string> = {};
    const pending: Promise<boolean>[] = [];
    let lexicalOk = true;
    current.mounts.forEach((mount, index) => {
      if (mount.kind !== "project" || mount.project.trim() === "") return;
      const lexical = decideProjectPath({
        origin: "typed",
        project: mount.project,
        directoryExists: true,
      });
      if (!lexical.ok) {
        lexicalOk = false;
        next[index] = {
          state: "error",
          project: mount.project,
          error: templateProjectPathError(
            tRef.current,
            mount.project,
            lexical.reason,
          ),
        };
        return;
      }
      if (picker === undefined) {
        next[index] = { state: "ok", project: mount.project };
        return;
      }
      // The answer the row already holds stays stored while the re-check runs,
      // so a row that failed keeps naming its failure — and keeps its error
      // paragraph mounted — until this check resolves. The pending state is
      // tracked beside the checks, never written over the stored answer.
      const settled = projectChecksRef.current[index];
      if (settled !== undefined && settled.state !== "pending") {
        next[index] = settled;
      }
      inFlight[index] = mount.project;
      pending.push(
        templateProjectPathDecision({
          project: mount.project,
          projectsRoot: root,
          listDirectory: (path: string) => picker.list(path),
        }).then((decision) => {
          if (token !== checkToken.current) return false;
          const answer: TemplateProjectCheck = decision.ok
            ? { state: "ok", project: mount.project }
            : {
              state: "error",
              project: mount.project,
              error: templateProjectPathError(
                tRef.current,
                mount.project,
                decision.reason,
              ),
            };
          // An answer that repeats the stored one is not written back, so a
          // re-check never renders the popup for no reason.
          setProjectChecks((previous) => {
            const updated = { ...previous, [index]: answer };
            return templateProjectChecksEqual(previous, updated)
              ? previous
              : updated;
          });
          // This row is no longer pending: the answer above is the one the row
          // and its error now report.
          setProjectChecksInFlight((previous) => {
            if (previous[index] !== mount.project) return previous;
            const updated = { ...previous };
            delete updated[index];
            return updated;
          });
          return decision.ok;
        }),
      );
    });
    setProjectChecks((previous) =>
      templateProjectChecksEqual(previous, next) ? previous : next
    );
    setProjectChecksInFlight(inFlight);
    const results = await Promise.all(pending);
    if (token !== checkToken.current) return false;
    return lexicalOk && results.every((ok) => ok);
  }, []);

  // A freshly seeded draft is checked once the moment it appears; later edits
  // wait for the field's blur or Continue, so typing never asks the host. A
  // resumed draft is seeded from the payload instead, so its own effect below
  // is the one that checks it.
  const draftSeeded = draft !== null;
  useEffect(() => {
    if (!open || !draftSeeded || initialDraft !== undefined) return;
    void checkProjects();
  }, [open, draftSeeded, initialDraft, checkProjects]);

  // A resumed draft is already non-null when the popup opens, so the effect
  // above never sees the null-to-draft transition: its project paths are
  // checked once here, exactly as a freshly seeded draft is checked on open.
  useEffect(() => {
    if (!open || initialDraft === undefined) return;
    void checkProjects(initialDraft);
  }, [open, initialDraft, checkProjects]);

  // projectCheck is the state the current draft's row shows. A check started
  // for another value is not this row's answer, so the value's lexical decision
  // stands instead; a changed value the host is listing right now reports
  // pending. A mount added or removed before a row shifts its index, so a check
  // stored for the same path under another index still answers it. A host
  // failure already found on the row stays on screen while the user types — only
  // a blur re-checks it — and the lexical check still reports an invalid shape
  // immediately.
  const projectCheck = (
    index: number,
    project: string,
  ): TemplateProjectCheck => {
    const stored = projectChecks[index];
    // The field's value changed and the host is listing it now: this row is
    // pending, while the answer stored for it stays put and stays readable as
    // the row's message until the check resolves.
    if (
      projectChecksInFlight[index] === project &&
      (stored === undefined || stored.project !== project)
    ) {
      return { state: "pending", project };
    }
    const checked = stored !== undefined && stored.project === project
      ? stored
      : Object.values(projectChecks).find((check) => check.project === project);
    if (checked !== undefined) return checked;
    const lexical = decideProjectPath({
      origin: "typed",
      project,
      directoryExists: true,
    });
    if (!lexical.ok) {
      return {
        state: "error",
        project,
        error: templateProjectPathError(t, project, lexical.reason),
      };
    }
    // The row already failed on the value it had: keep that error on screen
    // while the user types until a blur re-checks the new value.
    if (stored !== undefined && stored.state === "error") return stored;
    // No check has started for this value at all — a mount the user has just
    // added, whose path the Add-mount popup validated itself. Continue's own
    // check still lists it before handing the draft on.
    return { state: "ok", project };
  };

  // The draft's references and the ones that do not exist yet. A pending
  // project check is not a known path, so it still counts as outstanding: the
  // footer's number stays put while its re-check runs, and a missing reference
  // outranks the checking state it may also be in.
  const references = draft === null ? [] : templateDraftReferences(draft);
  const projectReferences = references.filter(
    (reference): reference is TemplateDraftReference & { mountIndex: number } =>
      reference.kind === "project" && reference.mountIndex !== undefined,
  );
  const pendingProjects = projectReferences
    .filter((reference) =>
      projectCheck(reference.mountIndex, reference.name).state === "pending"
    )
    .map((reference) => reference.mountIndex);
  const validProjects = projectReferences
    .filter((reference) =>
      projectCheck(reference.mountIndex, reference.name).state === "ok"
    )
    .map((reference) => reference.name);
  const missingReferences = draft === null
    ? []
    : templateDraftMissingReferences(references, {
      secrets,
      volumes,
      projects: validProjects,
    });
  const missingCount = missingReferences.length;
  const block = templateBlockReason({
    inspection,
    draftImage: draft?.image ?? "",
    images,
    buildInProgress: building,
    buildFailed,
    pendingReferences: pendingProjects.length,
    missingReferences: missingCount,
    mode,
    replaceTarget,
  });
  // The image card's one action: the template's own image keeps the template
  // route, while another listed image offers the action the Images tab would
  // give it. The command behind the action is what the button click runs.
  const imageAction = templateImageAction({
    plan: inspection === null ? null : inspection.image,
    draftImage: draft?.image ?? "",
    images,
    building,
    buildFailed,
  });
  // The button is disabled while the session is busy, while a build's own
  // progress runs and in a read-only session. One label set serves every route:
  // the action decides the wording, never the command behind it, and a running
  // build or rebuild says so with the shared short words instead of the generic
  // busy state.
  const imageActionRunning = busy || imageAction.action === "building" ||
    imageAction.action === "rebuilding";
  const imageActionDisabled = !writable || imageActionRunning;
  const imageActionRunningLabel = imageAction.action === "pull"
    ? t("busy")
    : imageAction.action === "rebuild" ||
        imageAction.action === "rebuilding"
    ? t("rebuilding")
    : t("building");
  const imageActionLabel = imageActionRunning
    ? imageActionRunningLabel
    : imageAction.action === "pull"
    ? t("pullImage")
    : imageAction.action === "rebuild"
    ? t("rebuildImage")
    : t("build");
  // Everything the editors' own `enabled` gate covers: a busy session cannot
  // edit the draft, matching the container editor.
  const enabled = !busy;
  const filteredContainers = useMemo(() => {
    const filter = replaceFilter.trim().toLowerCase();
    if (filter === "") return containers;
    return containers.filter((container) =>
      container.containerName.toLowerCase().includes(filter)
    );
  }, [containers, replaceFilter]);
  const canContinue = !busy && block === undefined && inspection !== null &&
    draft !== null;
  // The image group's facts for the draft's image: the template plan while the
  // draft runs the derived id, another listed image's own facts otherwise.
  const imageFacts = inspection === null || draft === null
    ? undefined
    : templateDraftImageFacts(inspection.image, draft.image, images);
  // Every image the picker offers: the template's own image first, then the
  // other base images, then the other custom images, each group sorted by image
  // id, and never the reserved PTC image. The template's own image is kept even
  // while the workspace list lacks it: a custom template's derived image only
  // appears there once built, and the picker must be able to return to it after
  // switching away.
  const candidates = templateImageCandidates(
    inspection === null ? null : inspection.image,
    images,
  );
  // The one row a validation message belongs under: a project's check error, or
  // a volume or secret mount whose source the workspace no longer holds. Every
  // message names the offending value; an emptied field says what to choose.
  const mountRowError = (
    mount: TemplateEditorConfig["mounts"][number],
    index: number,
  ): string | undefined => {
    if (mount.kind === "project") {
      const check = projectCheck(index, mount.project);
      // A failed answer stays the row's message while the changed value is
      // checked, so the error paragraph is updated in place instead of being
      // unmounted for the length of the host call.
      if (check.state === "error") return check.error;
      if (check.state === "pending") {
        const stored = projectChecks[index];
        if (stored !== undefined && stored.state === "error") {
          return stored.error;
        }
      }
      return undefined;
    }
    if (mount.kind === "volume") {
      if (mount.volume === "") return t("templateChooseVolume");
      return !volumes.some((volume) => volume.name === mount.volume)
        ? t("templateVolumeMissing", { volume: mount.volume })
        : undefined;
    }
    if (mount.kind === "secret") {
      if (mount.secret === "") return t("templateChooseSecret");
      return !secrets.some((secret) => secret.name === mount.secret)
        ? t("templateSecretMissing", { secret: mount.secret })
        : undefined;
    }
    return undefined;
  };
  // The same message for a secret environment value.
  const secretEnvRowError = (
    _name: string,
    secret: string,
  ): string | undefined => {
    if (secret === "") return t("templateChooseSecret");
    return !secrets.some((candidate) => candidate.name === secret)
      ? t("templateSecretMissing", { secret })
      : undefined;
  };
  const changeDraft = (patch: Partial<TemplateEditorConfig>): void => {
    if (draft === null) return;
    const next = { ...draft, ...patch };
    // The host check reads the draft through its ref, so a change that starts
    // one must be visible to it before the check runs.
    draftRef.current = next;
    setDraft(next);
  };
  // The one line that says why Continue is disabled, or nothing when the popup
  // already states the reason elsewhere.
  const blockText = blockingReasonText(t, block, building, missingCount);
  // The popup's Create volume / Create secret actions: each is offered only
  // while the draft mounts a storage of that kind, so a clean template shows
  // just Add mount. Both open the same create forms the settings storage tab
  // and the mount rows use.
  const draftMounts = draft?.mounts ?? [];
  const hasVolumeMount = draftMounts.some((mount) => mount.kind === "volume");
  const hasSecretMount = draftMounts.some((mount) => mount.kind === "secret");
  const mountActions = !hasVolumeMount && !hasSecretMount ? undefined : (
    <>
      {hasVolumeMount
        ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!writable || busy}
            onClick={() => setVolumeCreateOpen(true)}
          >
            {t("createVolume")}
          </Button>
        )
        : null}
      {hasSecretMount
        ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!writable || busy}
            onClick={() => setSecretCreateOpen(true)}
          >
            {t("createSecret")}
          </Button>
        )
        : null}
    </>
  );
  // The row's Browse opens the host directory picker on the row's current path;
  // the pick fills the project field and then runs the same host check a blur
  // would.
  const browseProject = useCallback(
    (index: number): void => setProjectBrowse(index),
    [],
  );
  const chooseProject = (path: string): void => {
    const index = projectBrowse;
    if (index === undefined || draft === null) return;
    const project = projectNameFromHostPath(projectsRoot, path) ?? path;
    changeDraft({
      mounts: draft.mounts.map((mount, at) =>
        at === index ? { ...mount, project } : mount
      ),
    });
    setProjectBrowse(undefined);
    void checkProjects();
  };

  // Continue never creates or replaces anything here: it hands the edited
  // draft to the create editor, or to the chosen container's edit editor. That
  // editor's own Apply is the one path that saves. A workspace with no
  // container yet gets its default editor, which creates the default container;
  // otherwise the named editor opens with an empty name for the user to choose.
  // The host check runs once here as well, so Continue never hands on a project
  // path that was never listed; a path that fails keeps the popup open.
  const continueToEditor = async (): Promise<void> => {
    if (inspection === null || draft === null || !canContinue) return;
    const projectsOk = await checkProjects();
    if (!projectsOk) return;
    // The check awaited above may have been overtaken by an edit; hand over the
    // draft as it now stands rather than the one captured at the click.
    const currentDraft = draftRef.current;
    if (currentDraft === null) return;
    // What the editor's Back returns to: the selection the popup was opened on,
    // this draft and the destination choice as the popup now shows them, never
    // the editor's own edits. The replace source is the inspection's canonical
    // document, which the host publishes once the editor's Apply succeeded.
    const source = { name: inspection.name, yaml: inspection.yaml };
    const resume: TemplateResume = {
      selection: selection ?? source,
      draft: currentDraft,
      mode,
      replaceTarget,
      replaceFilter,
    };
    if (mode === "create") {
      onContinue(
        "create",
        containers.length === 0 ? "default" : "",
        currentDraft,
        undefined,
        resume,
      );
      return;
    }
    onContinue(
      "replace",
      replaceTarget,
      currentDraft,
      source,
      resume,
    );
  };

  const templateName = selection === null
    ? t("templateDetails")
    : templateDisplayName(selection.name);
  const fileName = inspection?.name ?? selection?.name ?? "";
  const footer = (
    <div style={footerRow}>
      {
        /* The left slot: a blocking reason is announced as an alert and painted
           in the harness's error colour, the same one a mount error uses. With
           no blocking reason the slot stays empty, so informational wording
           would never be painted as an error. */
      }
      <span
        style={blockText === undefined ? footerReason : footerReasonError}
        role={blockText === undefined ? "status" : "alert"}
      >
        {blockText ?? ""}
      </span>
      <div style={footerActions}>
        <Button variant="outline" size="sm" onClick={onBack}>
          {t("templateBack")}
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canContinue}
          style={templateAction}
          onClick={() => void continueToEditor()}
        >
          {t("templateContinue")}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={templateName}
        closeLabel={t("cancel")}
        className={TEMPLATE_DIALOG_CLASS}
        contentClassName={TEMPLATE_DIALOG_CONTENT_CLASS}
        footer={footer}
      >
        <div style={detailsBody}>
          <div style={detailsHeader}>
            <p style={detailsFile}>{fileName}</p>
            <div style={destinationBlock}>
              <SegmentedControl
                id={destinationId}
                value={mode}
                options={[
                  { value: "create", label: t("templateCreate") },
                  {
                    value: "replace",
                    label: t("templateReplaceContainer"),
                    disabled: containers.length === 0,
                  },
                ]}
                onChange={(next) => {
                  setMode(next);
                  if (next === "replace" && replaceTarget === "") {
                    setReplaceTarget(
                      containers[0]?.containerName ?? "",
                    );
                  }
                }}
                label={t("templateDestination")}
              />
              {mode === "create"
                ? (
                  <p style={destinationHint}>
                    {containers.length === 0
                      ? t("templateCreateDefaultHint")
                      : t("templateCreateHint")}
                  </p>
                )
                : (
                  <div style={replaceBlock}>
                    {containers.length > 5
                      ? (
                        <Input
                          type="search"
                          aria-label={t("templateFilterTargets")}
                          placeholder={t("templateFilterTargets")}
                          value={replaceFilter}
                          disabled={containers.length === 0}
                          onChange={(event) =>
                            setReplaceFilter(event.target.value)}
                        />
                      )
                      : null}
                    <div
                      role="radiogroup"
                      aria-label={t("templateDestination")}
                      style={replaceList}
                    >
                      {filteredContainers.length === 0
                        ? (
                          <span style={missingValue}>
                            {t("templateNoMatchingContainers")}
                          </span>
                        )
                        : filteredContainers.map((container) => {
                          const isSelected = replaceTarget ===
                            container.containerName;
                          return (
                            <Button
                              key={container.containerName}
                              variant="outline"
                              size="md"
                              role="radio"
                              aria-checked={isSelected}
                              disabled={containers.length === 0}
                              style={replaceChoiceStyle(isSelected)}
                              onClick={() =>
                                setReplaceTarget(container.containerName)}
                            >
                              <span style={choiceText}>
                                <span style={choiceName}>
                                  {container.containerName}
                                </span>
                                <span style={choiceMeta}>
                                  {container.imageId}
                                </span>
                              </span>
                              {isSelected
                                ? <IconCheckOutlineRegular size={16} />
                                : null}
                            </Button>
                          );
                        })}
                    </div>
                  </div>
                )}
            </div>
          </div>
          {error === "" ? null : (
            <p role="alert" style={errorText}>
              {error}
            </p>
          )}
          {inspection === null || draft === null
            ? error === ""
              ? <p style={hint} role="status">{t("templateLoading")}</p>
              : null
            : (
              <>
                {
                  /* The image group keeps the row-list marker around its card:
                  the card is a list, so the marker keeps its facts' narrow
                  layout and the gap between the card and a failed build. The
                  picker sits above the same card, so the image it edits and the
                  facts that describe it read together. */
                }
                {imageFacts === undefined
                  ? null
                  : (
                    <DialogGroup title={t("image")}>
                      <div className={ROW_LIST_CLASS} style={fieldGroup}>
                        <ImageRow
                          t={t}
                          mode="edit"
                          image={draft.image}
                          candidates={candidates}
                          disabled={!enabled}
                          onChange={(image) => changeDraft({ image })}
                        />
                        <ImageFacts
                          t={t}
                          locale={locale}
                          imageId={imageFacts.imageId}
                          status={imageFacts.status}
                          builtAt={imageFacts.builtAt}
                          source={imageFacts.source}
                          packages={imageFacts.packages}
                          actions={imageAction.action === "none"
                            ? undefined
                            : (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={imageActionDisabled}
                                aria-busy={imageActionRunning}
                                style={templateAction}
                                onClick={() => runImageAction(imageAction)}
                              >
                                {imageActionLabel}
                              </Button>
                            )}
                        />
                        {buildFailed === "" ||
                            draft.image !== inspection.imageId
                          ? null
                          : (
                            <p role="alert" style={errorText}>
                              {buildFailed}
                            </p>
                          )}
                      </div>
                    </DialogGroup>
                  )}
                {
                  /* The draft's field groups are the container editor's own
                  dialog groups and field components, in its order and under its
                  titles: environment, mounts, PATH additions, secret
                  environment and ports. Every row edits the draft, so the
                  values Continue hands over are exactly what the user saw. */
                }
                <div style={blockFields}>
                  <DialogGroup title={t("envTitle")}>
                    <EnvEditor
                      t={t}
                      env={draft.env}
                      busy={busy}
                      onChange={(env) => changeDraft({ env })}
                    />
                  </DialogGroup>
                  <DialogGroup title={t("mountsTitle")}>
                    <MountsEditor
                      t={t}
                      mounts={draft.mounts}
                      volumes={volumes}
                      secrets={secrets}
                      busy={busy}
                      enabled={enabled}
                      writable={writable}
                      projectsRoot={projectsRoot}
                      directoryPicker={directoryPicker}
                      mainProject={workspace.projectName}
                      projectPathEditable
                      rowError={mountRowError}
                      onProjectBlur={() => void checkProjects()}
                      onProjectBrowse={directoryPicker === undefined
                        ? undefined
                        : browseProject}
                      projectBrowseLabel={t("templateBrowse")}
                      actions={mountActions}
                      onCreateVolume={createVolume}
                      onCreateSecret={onCreateSecret}
                      onAdd={(mount) =>
                        changeDraft({ mounts: [...draft.mounts, mount] })}
                      onRemove={(mount) =>
                        changeDraft({
                          mounts: draft.mounts.filter((item) => item !== mount),
                        })}
                      onUpdate={(mount, index) =>
                        changeDraft({
                          mounts: draft.mounts.map((item, at) =>
                            at === index ? mount : item
                          ),
                        })}
                    />
                  </DialogGroup>
                  <DialogGroup title={t("pathsTitle")}>
                    <PathsEditor
                      t={t}
                      paths={draft.paths}
                      busy={busy}
                      enabled={enabled}
                      onApply={(paths) => changeDraft({ paths })}
                    />
                  </DialogGroup>
                  <DialogGroup title={t("containerSecretsTitle")}>
                    <SecretEnvEditor
                      t={t}
                      secretEnv={draft.secretEnv}
                      secrets={secrets}
                      busy={busy}
                      enabled={enabled}
                      writable={writable}
                      onCreateSecret={onCreateSecret}
                      onChange={(secretEnv) => changeDraft({ secretEnv })}
                      rowError={secretEnvRowError}
                    />
                  </DialogGroup>
                  <DialogGroup title={t("portsTitle")}>
                    <PortsEditor
                      t={t}
                      ports={draft.ports}
                      busy={busy}
                      enabled={enabled}
                      canPublish={enabled && !gatewayUnavailable}
                      gatewayUnavailable={gatewayUnavailable}
                      onChange={(ports) => changeDraft({ ports })}
                    />
                  </DialogGroup>
                </div>
              </>
            )}
        </div>
      </Modal>
      <CreateVolumeModal
        t={t}
        open={volumeCreateOpen}
        busy={busy}
        writable={writable}
        onCreate={(name) => {
          void createVolume(name);
        }}
        onClose={() => setVolumeCreateOpen(false)}
      />
      <SecretModal
        t={t}
        mode="create"
        open={secretCreateOpen}
        busy={busy}
        writable={writable}
        onCreate={(name, length, charset) => {
          void onCreateSecret(name, length, charset);
        }}
        onClose={() => setSecretCreateOpen(false)}
      />
      {directoryPicker === undefined || projectBrowse === undefined ||
          draft === null
        ? null
        : (
          <DirectoryPickerModal
            t={t}
            open
            root={projectsRoot}
            start={hostPathForProjectName(
              projectsRoot,
              draft.mounts[projectBrowse]?.project ?? "",
            )}
            picker={directoryPicker}
            onSelect={chooseProject}
            onClose={() => setProjectBrowse(undefined)}
          />
        )}
    </>
  );
}

export function LoadTemplateModal(props: {
  t: Translate;
  // The plugin's active locale, for the build time's relative wording.
  locale: string;
  open: boolean;
  workspace: WorkspaceView;
  containers: readonly ContainerView[];
  // The workspace's images, offered by the popup's image picker; the template's
  // derived image is one candidate among them.
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  defaultEnv: Record<string, string>;
  // The projects root a project mount's destination is derived from.
  projectsRoot: string;
  // The host directory picker the project references are checked through;
  // absent in deployments that mount none, which keeps the lexical answer.
  directoryPicker?: DirectoryPickerFace;
  busy: boolean;
  writable: boolean;
  // Whether the snapshot knows the port-publishing gateway is missing or
  // incompatible, so the ports group says so instead of staging an unpublishable
  // port.
  gatewayUnavailable: boolean;
  actions: TemplateActions;
  // The Images tab's own image controls, shared so the details popup's image
  // card runs the same commands for an image other than the template's.
  onBuildImage: (imageId: string, parent: string, packages: string[]) => void;
  onRebuildImage: (imageId: string) => void;
  onRebuildBaseImage: (name: string) => void;
  onPullBaseImage: (name: string) => void;
  onCreateSecret: (
    name: string,
    length?: number,
    charset?: string,
  ) => Promise<boolean>;
  // Creates a volume the mount editor offers, reporting whether the host
  // accepted it.
  createVolume: (name: string) => Promise<boolean>;
  onReload: () => void;
  // The details step to reopen after an editor's Back, carrying the selection,
  // the draft and the destination choice Continue handed on. Absent for a picker
  // open.
  resume?: TemplateResume | null;
  onClose: () => void;
  onContinue: (
    mode: "create" | "replace",
    container: string,
    config: ContainerConfig,
    source?: TemplateSource,
    resume?: TemplateResume,
  ) => void;
}): ReactNode {
  const {
    t,
    locale,
    open,
    workspace,
    containers,
    images,
    volumes,
    secrets,
    defaultEnv,
    projectsRoot,
    directoryPicker,
    busy,
    writable,
    gatewayUnavailable,
    actions,
    onBuildImage,
    onRebuildImage,
    onRebuildBaseImage,
    onPullBaseImage,
    onCreateSecret,
    createVolume,
    onReload,
    resume,
    onClose,
    onContinue,
  } = props;
  const [stage, setStage] = useState<"pick" | "details">("pick");
  const [selection, setSelection] = useState<TemplateSelection | null>(null);

  // Closing returns the flow to the picker, so reopening never resumes on a
  // previously chosen template. Opening with a resume payload instead skips the
  // picker and reopens the details step for that selection.
  useEffect(() => {
    if (!open) {
      setStage("pick");
      setSelection(null);
      return;
    }
    if (resume === undefined || resume === null) return;
    setSelection(resume.selection);
    setStage("details");
  }, [open, resume]);

  // The resume payload only seeds the selection it was recorded for: choosing
  // another template starts that one from the template's own plan.
  const resumeActive = resume !== undefined && resume !== null &&
      selection !== null && selection.name === resume.selection.name &&
      selection.yaml === resume.selection.yaml
    ? resume
    : undefined;

  return (
    <>
      <TemplatePickerModal
        t={t}
        open={open && stage === "pick"}
        workspace={workspace}
        busy={busy}
        actions={actions}
        onClose={onClose}
        onChoose={(chosen) => {
          setSelection(chosen);
          setStage("details");
        }}
      />
      <TemplateDetailsModal
        t={t}
        locale={locale}
        open={open && stage === "details"}
        workspace={workspace}
        containers={containers}
        images={images}
        volumes={volumes}
        secrets={secrets}
        defaultEnv={defaultEnv}
        projectsRoot={projectsRoot}
        directoryPicker={directoryPicker}
        busy={busy}
        writable={writable}
        gatewayUnavailable={gatewayUnavailable}
        actions={actions}
        onBuildImage={onBuildImage}
        onRebuildImage={onRebuildImage}
        onRebuildBaseImage={onRebuildBaseImage}
        onPullBaseImage={onPullBaseImage}
        onCreateSecret={onCreateSecret}
        createVolume={createVolume}
        onReload={onReload}
        selection={selection}
        initialDraft={resumeActive?.draft}
        initialMode={resumeActive?.mode}
        initialReplaceTarget={resumeActive?.replaceTarget}
        initialReplaceFilter={resumeActive?.replaceFilter}
        onBack={() => setStage("pick")}
        onClose={onClose}
        onContinue={onContinue}
      />
    </>
  );
}
