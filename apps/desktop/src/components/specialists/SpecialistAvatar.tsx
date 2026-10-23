import {
  Atom,
  BookOpen,
  Brain,
  Calculator,
  ChartColumn,
  ChartLine,
  Code,
  Database,
  Dna,
  FileText,
  FlaskConical,
  Globe,
  GraduationCap,
  HeartPulse,
  Image,
  Languages,
  Leaf,
  Lightbulb,
  ListChecks,
  Microscope,
  PenLine,
  Presentation,
  Quote,
  Search,
  ShieldCheck,
  Sigma,
  Telescope,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { specialistInitial } from "@/lib/specialists";

/** The icons a specialist can wear, by the key saved in its file. Picked for
 *  research work — writing, reading, numbers, the lab, review — so a row of
 *  specialists reads as a team at a glance. Order is the picker's order; with
 *  the first-letter choice they fill exactly two rows of the editor. */
export const SPECIALIST_ICONS: ReadonlyArray<readonly [string, LucideIcon]> = [
  ["pen-line", PenLine],
  ["book-open", BookOpen],
  ["quote", Quote],
  ["file-text", FileText],
  ["presentation", Presentation],
  ["languages", Languages],
  ["chart-column", ChartColumn],
  ["chart-line", ChartLine],
  ["sigma", Sigma],
  ["calculator", Calculator],
  ["database", Database],
  ["code", Code],
  ["flask-conical", FlaskConical],
  ["microscope", Microscope],
  ["dna", Dna],
  ["atom", Atom],
  ["leaf", Leaf],
  ["heart-pulse", HeartPulse],
  ["telescope", Telescope],
  ["brain", Brain],
  ["globe", Globe],
  ["search", Search],
  ["image", Image],
  ["shield-check", ShieldCheck],
  ["list-checks", ListChecks],
  ["lightbulb", Lightbulb],
  ["graduation-cap", GraduationCap],
];

const ICONS = new Map(SPECIALIST_ICONS);

/**
 * A specialist's tile: its icon (or, without one, the first letter of its
 * name) in its color, over a faint tint of the same color with a hairline of
 * it around the edge — the edge is what keeps a light tint from dissolving
 * into the page. No color: the neutral tile the other rows on the page use.
 * An icon key this build does not know falls back to the letter.
 */
export function SpecialistAvatar({
  id,
  color,
  icon,
  large = false,
}: {
  id: string;
  color: string | null;
  icon: string | null;
  large?: boolean;
}) {
  const Icon = icon ? ICONS.get(icon) : undefined;
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center font-medium",
        large ? "h-14 w-14 rounded-[16px] text-[22px]" : "h-10 w-10 rounded-[11px] text-[16px]",
        !color && "border border-border bg-surface-2 text-text",
      )}
      // 0x1F ≈ 12% fill, 0x40 = 25% edge: reads on both themes.
      style={
        color ? { color, backgroundColor: `${color}1F`, boxShadow: `inset 0 0 0 1px ${color}40` } : undefined
      }
    >
      {Icon ? <Icon size={large ? 26 : 19} strokeWidth={1.75} /> : specialistInitial(id)}
    </div>
  );
}
