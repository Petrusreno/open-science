import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Search, X } from "lucide-react";
import type { McpServer, ProviderInfo, SkillInfo } from "@ai4s/sdk";
import { Switch } from "@/components/settings/Section";
import { flattenModelOptions, selectableModelOptions } from "@/components/settings/modelCatalog";
import { inputCls } from "@/components/settings/inputCls";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { useRuntimeStore } from "@/lib/runtime";
import {
  connectorCollisions,
  connectorPrefix,
  MAX_DESCRIPTION,
  MAX_INSTRUCTIONS,
  NATIVE_AGENTS,
  SPECIALIST_COLORS,
  specialistId,
  specialistInitial,
  type Specialist,
} from "@/lib/specialists";
import { SPECIALIST_ICONS, SpecialistAvatar } from "./SpecialistAvatar";

/**
 * Create or edit one specialist (#144).
 *
 * One dialog, read top to bottom in the order a person decides: who it is,
 * when the main agent should hand it work, how it behaves, and what it may
 * touch. Everything that limits it starts open — every skill, every connector
 * — so a specialist made with only a name and a description already works.
 *
 * Saving restarts the runtime (that is when it rebuilds its agents), so the
 * button says so while it waits rather than looking frozen.
 *
 * Nothing in it navigates away: leaving would throw the draft away, so every
 * choice it needs (the model included) is made in place.
 */
export function SpecialistEditor({
  initial,
  takenIds,
  skills,
  connectors,
  providers,
  onSave,
  onDelete,
  onClose,
}: {
  /** null to create a new one. */
  initial: Specialist | null;
  /** Every agent name already in use, so a new id can be refused as typed. */
  takenIds: string[];
  skills: SkillInfo[];
  /** null while they are still being read: the editor opens without waiting. */
  connectors: McpServer[] | null;
  /** The model catalog, for the model picker. */
  providers: ProviderInfo[];
  onSave: (specialist: Specialist, create: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation(["pages", "common"]);
  const creating = initial === null;
  const defaultModel = useRuntimeStore((s) => s.defaultModel);

  const [name, setName] = useState(initial?.id ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [icon, setIcon] = useState<string | null>(initial?.icon ?? null);
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [skillScope, setSkillScope] = useState<string[] | null>(initial?.skills ?? null);
  const [blocked, setBlocked] = useState<string[]>(initial?.blockedConnectors ?? []);
  const [model, setModel] = useState(initial?.model ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "discard" | null>(null);
  const [touched, setTouched] = useState(false);

  const id = creating ? specialistId(name) : (initial?.id ?? "");
  const idProblem = !creating
    ? null
    : !name.trim()
      ? "required"
      : !id
        ? "empty"
        : NATIVE_AGENTS.includes(id) || takenIds.includes(id)
          ? "taken"
          : null;
  const descriptionMissing = !description.trim();

  const connectorPrefixes = useMemo(
    () => (connectors ?? []).map((c) => connectorPrefix(c.name)),
    [connectors],
  );
  const collisions = connectorCollisions(
    blocked,
    connectorPrefixes.filter((p) => !blocked.includes(p)),
  );

  const draft: Specialist = {
    id,
    description: description.trim(),
    color,
    icon,
    instructions: instructions.trim(),
    skills: skillScope,
    // Only blocks for connectors that still exist: one removed since keeps no
    // rule. Until the list is in, every block stays as it was.
    blockedConnectors: connectors ? blocked.filter((p) => connectorPrefixes.includes(p)) : blocked,
    model,
  };
  const dirty = creating
    ? Boolean(
        name.trim() ||
        description.trim() ||
        instructions.trim() ||
        color ||
        icon ||
        skillScope ||
        blocked.length ||
        model,
      )
    : JSON.stringify(draft) !== JSON.stringify(normalized(initial));
  const canSave = !idProblem && !descriptionMissing && collisions.length === 0 && (creating || dirty);

  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirm("discard");
    else onClose();
  };

  // Escape closes — except while a confirmation is up, which owns the key.
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => {
    if (confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirm]);

  const save = async () => {
    setTouched(true);
    if (!canSave) return;
    setBusy("save");
    setError(null);
    try {
      await onSave(draft, creating);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!initial) return;
    setConfirm(null);
    setBusy("delete");
    setError(null);
    try {
      await onDelete(initial.id);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(null);
    }
  };

  const displayName = id || name.trim() || t("skills.specialists.untitled");

  // The catalog grouped by provider, as Settings › Models lists it.
  const modelOptions = useMemo(() => flattenModelOptions(providers), [providers]);
  const modelGroups = useMemo(() => {
    const map = new Map<string, { name: string; models: { key: string; name: string }[] }>();
    for (const o of selectableModelOptions(modelOptions)) {
      const group = map.get(o.providerID) ?? { name: o.providerName, models: [] };
      group.models.push({ key: o.key, name: o.modelName });
      map.set(o.providerID, group);
    }
    return [...map.values()];
  }, [modelOptions]);
  const defaultModelName = modelOptions.find((o) => o.key === defaultModel)?.modelName;
  // A pinned model the catalog no longer serves stays selectable, so the picker
  // never claims "default" while the config still pins something else.
  const unlisted = model && !modelGroups.some((g) => g.models.some((m) => m.key === model)) ? model : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={creating ? t("skills.specialists.newTitle") : t("skills.specialists.editTitle", { id })}
        className="flex max-h-full w-[640px] max-w-full flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card"
      >
        <header className="flex items-center gap-3 border-b border-faint px-5 py-3.5">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium text-text">
            {creating ? t("skills.specialists.newTitle") : t("skills.specialists.editTitle", { id })}
          </h2>
          <button
            onClick={requestClose}
            aria-label={t("skills.specialists.close")}
            className="rounded-input p-1 text-muted hover:bg-surface-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {/* ---- Who it is: the avatar previews every choice below it ---- */}
          <div className="flex items-start gap-4">
            <SpecialistAvatar id={displayName} color={color} icon={icon} large />
            {creating ? (
              <div className="min-w-0 flex-1">
                <label htmlFor="specialist-name" className="text-[13px] font-medium text-text">
                  {t("skills.specialists.name")}
                </label>
                <input
                  id="specialist-name"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("skills.specialists.namePlaceholder")}
                  aria-invalid={touched && idProblem !== null}
                  className={inputCls("mt-1.5 w-full")}
                />
                <p
                  // A taken or unusable name is said as it is typed; an empty one
                  // only once Create was pressed.
                  className={cn(
                    "mt-1.5 text-[12px]",
                    idProblem === "taken" || idProblem === "empty" || (touched && idProblem === "required")
                      ? "text-error"
                      : "text-muted",
                  )}
                >
                  {idProblem === "taken"
                    ? t("skills.specialists.idTaken", { id })
                    : idProblem === "empty"
                      ? t("skills.specialists.idEmpty")
                      : idProblem === "required"
                        ? t("skills.specialists.idHint")
                        : t("skills.specialists.idPreview", { id })}
                </p>
              </div>
            ) : (
              <div className="min-w-0 flex-1 self-center">
                <div className="truncate text-[17px] text-text">{displayName}</div>
                <div className="mt-0.5 text-[12px] text-muted">{t("skills.specialists.kind")}</div>
              </div>
            )}
          </div>

          <Field label={t("skills.specialists.color")}>
            <div
              role="radiogroup"
              aria-label={t("skills.specialists.color")}
              className="flex flex-wrap gap-2"
            >
              <Swatch
                label={t("skills.specialists.colors.ink")}
                selected={color === null}
                onSelect={() => setColor(null)}
                className="bg-text"
              />
              {SPECIALIST_COLORS.map((c) => (
                <Swatch
                  key={c.key}
                  label={t(`skills.specialists.colors.${c.key}`)}
                  selected={color?.toUpperCase() === c.hex}
                  onSelect={() => setColor(c.hex)}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </div>
          </Field>

          <Field label={t("skills.specialists.icon")}>
            <div
              role="radiogroup"
              aria-label={t("skills.specialists.icon")}
              className="flex flex-wrap gap-1.5"
            >
              <IconChoice
                label={t("skills.specialists.iconLetter")}
                selected={icon === null}
                color={color}
                onSelect={() => setIcon(null)}
              >
                <span className="text-[14px] font-medium">{specialistInitial(displayName)}</span>
              </IconChoice>
              {SPECIALIST_ICONS.map(([key, Icon]) => (
                <IconChoice
                  key={key}
                  label={key}
                  selected={icon === key}
                  color={color}
                  onSelect={() => setIcon(key)}
                >
                  <Icon size={16} strokeWidth={1.75} />
                </IconChoice>
              ))}
            </div>
          </Field>

          {/* ---- When to hand it work ---- */}
          <Field
            label={t("skills.specialists.whenToUse")}
            htmlFor="specialist-description"
            hint={t("skills.specialists.whenToUseHint")}
          >
            <textarea
              id="specialist-description"
              autoFocus={!creating}
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
              placeholder={t("skills.specialists.whenToUsePlaceholder")}
              aria-invalid={touched && descriptionMissing}
              rows={3}
              className={inputCls("h-auto w-full resize-y py-2 leading-relaxed")}
            />
            {touched && descriptionMissing && (
              <p className="mt-1.5 text-[12px] text-error">{t("skills.specialists.whenToUseRequired")}</p>
            )}
          </Field>

          {/* ---- How it behaves ---- */}
          <Field
            label={t("skills.specialists.instructions")}
            htmlFor="specialist-instructions"
            hint={t("skills.specialists.instructionsHint")}
            aside={<span className="tabular-nums">{instructions.length.toLocaleString()}</span>}
          >
            <textarea
              id="specialist-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value.slice(0, MAX_INSTRUCTIONS))}
              placeholder={t("skills.specialists.instructionsPlaceholder")}
              rows={8}
              className={inputCls("h-auto w-full resize-y py-2 leading-relaxed")}
            />
          </Field>

          <Field label={t("skills.specialists.model")} htmlFor="specialist-model">
            <select
              id="specialist-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={inputCls("w-full")}
            >
              <option value="">
                {defaultModelName
                  ? t("skills.specialists.modelDefaultNamed", { model: defaultModelName })
                  : t("skills.specialists.modelDefault")}
              </option>
              {unlisted && (
                <option value={unlisted}>{t("skills.specialists.modelUnlisted", { model: unlisted })}</option>
              )}
              {modelGroups.map((g) => (
                <optgroup key={g.name} label={g.name}>
                  {g.models.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          {/* ---- What it may use ---- */}
          <div className="mt-7 border-t border-faint pt-5">
            <h3 className="text-[13px] font-semibold text-text">{t("skills.specialists.capabilities")}</h3>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
              {t("skills.specialists.capabilitiesHint")}
            </p>
          </div>

          <SkillScope skills={skills} scope={skillScope} onChange={setSkillScope} />

          <Field label={t("skills.specialists.connectors")} hint={t("skills.specialists.connectorsHint")}>
            {connectors === null ? (
              <p className="text-[13px] text-muted">{t("skills.specialists.connectorsLoading")}</p>
            ) : connectors.length === 0 ? (
              <p className="text-[13px] text-muted">{t("skills.specialists.noConnectors")}</p>
            ) : (
              <ul className="divide-y divide-[var(--border-faint)] rounded-input border border-border">
                {connectors.map((c) => {
                  const prefix = connectorPrefix(c.name);
                  const on = !blocked.includes(prefix);
                  return (
                    <li key={c.name} className="flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-text">{c.name}</span>
                      {c.status !== "connected" && (
                        <span className="shrink-0 text-[12px] text-muted">{c.status}</span>
                      )}
                      <Switch
                        checked={on}
                        label={c.name}
                        onChange={(next) =>
                          setBlocked((b) => (next ? b.filter((p) => p !== prefix) : [...b, prefix]))
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {collisions.map(([b, a]) => (
              <p key={`${b}:${a}`} className="mt-1.5 text-[12px] text-error">
                {t("skills.specialists.connectorCollision", {
                  blocked: b,
                  other: a,
                })}
              </p>
            ))}
          </Field>
        </div>

        <footer className="border-t border-faint px-5 py-3">
          {/* Its own line above the buttons, so a long reason never squeezes
              them — and an empty one takes no room at phone width. */}
          {error && (
            <p className="mb-2 text-[12px] text-error" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            {!creating && (
              <button
                onClick={() => setConfirm("delete")}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-input px-2.5 py-1.5 text-[13px] text-error hover:bg-error/10 disabled:opacity-40"
              >
                {busy === "delete" && <Loader2 size={13} className="animate-spin" />}
                {busy === "delete" ? t("skills.specialists.deleting") : t("skills.specialists.delete")}
              </button>
            )}
            <span className="flex-1" />
            <button
              onClick={requestClose}
              disabled={busy !== null}
              className="rounded-input px-3 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              {t("common:actions.cancel", "Cancel")}
            </button>
            <button
              onClick={() => void save()}
              // Errors already on screen disable it; a missing field is only
              // pointed out by the first press, so that press must still work.
              disabled={
                busy !== null ||
                (touched && !canSave) ||
                (!creating && !dirty) ||
                idProblem === "taken" ||
                idProblem === "empty" ||
                collisions.length > 0
              }
              className="inline-flex items-center gap-1.5 rounded-input bg-text px-3 py-1.5 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-40"
            >
              {busy === "save" && <Loader2 size={13} className="animate-spin" />}
              {busy === "save"
                ? t("skills.specialists.saving")
                : creating
                  ? t("skills.specialists.create")
                  : t("skills.specialists.save")}
            </button>
          </div>
        </footer>
      </div>

      {confirm === "delete" && initial && (
        <ConfirmDialog
          title={t("skills.specialists.deleteTitle", { id: initial.id })}
          body={t("skills.specialists.deleteBody")}
          confirmLabel={t("skills.specialists.delete")}
          onConfirm={() => void remove()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "discard" && (
        <ConfirmDialog
          title={t("skills.specialists.discardTitle")}
          body={t("skills.specialists.discardBody")}
          confirmLabel={t("skills.specialists.discard")}
          onConfirm={onClose}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/** The saved shape of `initial`, for an exact dirty check against the draft. */
function normalized(s: Specialist | null): Specialist | null {
  if (!s) return null;
  return {
    id: s.id,
    description: s.description.trim(),
    color: s.color ?? null,
    icon: s.icon ?? null,
    instructions: s.instructions.trim(),
    skills: s.skills,
    blockedConnectors: s.blockedConnectors,
    model: s.model ?? "",
  };
}

function Field({
  label,
  htmlFor,
  hint,
  aside,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mt-5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <label htmlFor={htmlFor} className="min-w-0 flex-1 text-[13px] font-medium text-text">
          {label}
        </label>
        {aside && <span className="shrink-0 text-[12px] text-muted">{aside}</span>}
      </div>
      {hint && <p className="-mt-0.5 mb-2 text-[12px] leading-relaxed text-muted">{hint}</p>}
      {children}
    </div>
  );
}

function Swatch({
  label,
  selected,
  onSelect,
  className,
  style,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 ring-offset-[var(--surface)] transition-shadow",
        selected ? "ring-2 ring-[var(--text)]" : "hover:ring-2 hover:ring-[var(--border)]",
      )}
    >
      <span className={cn("block h-5 w-5 rounded-full", className)} style={style} />
    </button>
  );
}

/** One icon in the picker. The chosen one takes the specialist's color, so
 *  the grid previews the tile it will make. */
function IconChoice({
  label,
  selected,
  color,
  onSelect,
  children,
}: {
  label: string;
  selected: boolean;
  color: string | null;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors",
        !selected && "text-muted hover:bg-surface-2 hover:text-text",
        selected && !color && "bg-surface-2 text-text ring-1 ring-[var(--text)]",
      )}
      style={
        selected && color
          ? { color, backgroundColor: `${color}1F`, boxShadow: `inset 0 0 0 1.5px ${color}` }
          : undefined
      }
    >
      {children}
    </button>
  );
}

/** Every skill, or only the ones picked — with a filter, because there are
 *  dozens. The list only appears once "Only selected" is chosen; until then
 *  there is nothing to decide. */
function SkillScope({
  skills,
  scope,
  onChange,
}: {
  skills: SkillInfo[];
  scope: string[] | null;
  onChange: (scope: string[] | null) => void;
}) {
  const { t } = useTranslation("pages");
  const [query, setQuery] = useState("");
  const names = useMemo(() => new Set(skills.map((s) => s.name)), [skills]);
  // Picked skills that are no longer installed stay listed (and removable):
  // dropping them silently would change what the specialist may use.
  const missing = (scope ?? []).filter((n) => !names.has(n));
  const needle = query.trim().toLowerCase();
  const rows = [
    ...missing.map((name) => ({
      name,
      description: t("skills.specialists.skillMissing"),
    })),
    ...[...skills].sort((a, b) => a.name.localeCompare(b.name)),
  ].filter(
    (s) => !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle),
  );

  const toggle = (name: string) => {
    const current = scope ?? [];
    onChange(current.includes(name) ? current.filter((n) => n !== name) : [...current, name]);
  };

  return (
    <Field label={t("skills.specialists.skills")}>
      <div
        role="radiogroup"
        aria-label={t("skills.specialists.skills")}
        className="inline-flex rounded-input bg-surface-2 p-0.5"
      >
        {[
          { value: false, label: t("skills.specialists.skillsAll") },
          { value: true, label: t("skills.specialists.skillsSome") },
        ].map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={(scope !== null) === opt.value}
            onClick={() => onChange(opt.value ? (scope ?? []) : null)}
            className={cn(
              "rounded-[6px] px-3 py-1 text-[13px] transition-colors",
              (scope !== null) === opt.value
                ? "bg-surface text-text shadow-sm"
                : "text-muted hover:text-text",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {scope !== null && (
        <div className="mt-2.5 rounded-input border border-border">
          <div className="flex items-center gap-2 border-b border-faint px-3">
            <Search size={13} className="shrink-0 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("skills.specialists.skillsFilter")}
              aria-label={t("skills.specialists.skillsFilter")}
              className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-muted"
            />
            <span className="shrink-0 text-[12px] tabular-nums text-muted">
              {t("skills.specialists.skillsSelected", { count: scope.length })}
            </span>
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {rows.length === 0 && (
              <li className="px-3 py-2 text-[13px] text-muted">{t("skills.specialists.skillsNoMatch")}</li>
            )}
            {rows.map((s) => {
              const checked = scope.includes(s.name);
              return (
                <li key={s.name}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggle(s.name)}
                    title={s.description || undefined}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-2"
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border",
                        checked ? "border-text bg-text text-bg" : "border-border",
                      )}
                    >
                      {checked && <Check size={11} strokeWidth={2.5} />}
                    </span>
                    <span className="shrink-0 text-[13px] text-text">{s.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{s.description}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {scope.length === 0 && (
            <p className="border-t border-faint px-3 py-2 text-[12px] text-muted">
              {t("skills.specialists.skillsNone")}
            </p>
          )}
        </div>
      )}
    </Field>
  );
}
