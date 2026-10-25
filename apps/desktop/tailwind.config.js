/** A theme colour variable that still honours `/NN` opacity modifiers. */
const token = (name) => `color-mix(in srgb, var(${name}) calc(<alpha-value> * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Each token takes an opacity modifier (`bg-surface/95`, `bg-accent/15`).
      // A bare `var(--x)` cannot: Tailwind silently emits NOTHING for the
      // modified class, and every tint and translucent surface in the app
      // rendered fully transparent (the "Latest" pill showed the text behind it).
      colors: {
        bg: token("--bg"),
        surface: token("--surface"),
        "surface-2": token("--surface-2"),
        border: token("--border"),
        faint: token("--border-faint"),
        text: token("--text"),
        muted: token("--muted"),
        accent: token("--accent"),
        "accent-fg": token("--accent-fg"),
        link: token("--link"),
        warn: token("--warn"),
        ok: token("--ok"),
        error: token("--error"),
      },
      fontFamily: {
        serif: ["'Source Serif 4'", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      borderRadius: {
        card: "14px",
        input: "10px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(40, 39, 35, 0.04), 0 4px 16px rgba(40, 39, 35, 0.05)",
        pop: "0 8px 30px rgba(40, 39, 35, 0.14)",
        // The composer capsule: a wider, fainter tier than `card`, so the
        // input floats over the thread without a drawn border.
        composer: "0 2px 6px rgba(40, 39, 35, 0.04), 0 12px 32px rgba(40, 39, 35, 0.08)",
      },
    },
  },
  plugins: [],
};
