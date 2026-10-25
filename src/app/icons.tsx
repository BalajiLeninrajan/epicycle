// Inline stroke icons (24-unit grid). Decorative: the control carries the accessible name.
import type { JSX } from 'preact'

function Icon(props: { children: JSX.Element | JSX.Element[]; class?: string }) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  )
}

export const PlayIcon = () => (
  <Icon>
    <path d="M7 4.5v15l12-7.5z" />
  </Icon>
)

export const PauseIcon = () => (
  <Icon>
    <path d="M8 4.5v15M16 4.5v15" />
  </Icon>
)

export const UploadIcon = (p: { class?: string }) => (
  <Icon class={p.class}>
    <path d="M12 15V3M7 8l5-5 5 5" />
    <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </Icon>
)

export const ClipboardIcon = () => (
  <Icon>
    <rect x="8" y="2.5" width="8" height="4" rx="1" />
    <path d="M16 4.5h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2" />
  </Icon>
)

export const DownloadIcon = () => (
  <Icon>
    <path d="M12 3v12M7 10l5 5 5-5" />
    <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </Icon>
)

export const ChevronIcon = () => (
  <Icon>
    <path d="m6 9 6 6 6-6" />
  </Icon>
)

/** Brand glyph: a circle with its radius arm and a traced curve. */
export const EpicycleIcon = (p: { class?: string }) => (
  <Icon class={p.class}>
    <circle cx="9" cy="12" r="6" />
    <path d="M9 12l4.5-4" />
    <path d="M13.5 8c2.5-2 5.5-1 6.5 2" />
  </Icon>
)
