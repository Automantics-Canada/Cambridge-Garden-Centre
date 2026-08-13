/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      // Names map 1:1 to the tokens in src/styles/tokens.css.
      // Prefer these over gray-*/blue-*/green-* so the theme stays coherent.
      colors: {
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        rail: 'rgb(var(--c-rail) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        'rail-ink': 'rgb(var(--c-rail-ink) / <alpha-value>)',
        brand: 'rgb(var(--c-brand) / <alpha-value>)',
        clay: 'rgb(var(--c-clay) / <alpha-value>)',
        ochre: 'rgb(var(--c-ochre) / <alpha-value>)',
        // Use these for text sitting on a filled brand/clay background.
        'on-brand': 'rgb(var(--c-on-brand) / <alpha-value>)',
        'on-clay': 'rgb(var(--c-on-clay) / <alpha-value>)',
      },
      borderRadius: {
        card: 'var(--r-card)',
        control: 'var(--r-control)',
        pill: 'var(--r-pill)',
      },
      boxShadow: {
        card: 'var(--sh-card)',
        lift: 'var(--sh-lift)',
      },
      fontFamily: {
        // Outfit is the rounded geometric face that gives direction C its
        // friendly, unintimidating feel. Poppins stays available for anything
        // still referencing it.
        sans: ['Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        poppins: ['Poppins', 'sans-serif'],
      },
      fontSize: {
        // Big, readable numbers are the point of this direction.
        stat: ['2.75rem', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
      },
    },
  },
  plugins: [],
}
