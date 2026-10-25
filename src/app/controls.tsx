// Small labeled form controls built on the design system recipes.
import type { ComponentChildren } from 'preact'
import { useId } from 'preact/hooks'

export function Slider(props: {
  label: string
  min: number
  max: number
  step?: number
  value: number
  /** Shown next to the label and announced as aria-valuetext. */
  display: string
  onInput(value: number): void
  disabled?: boolean
  extra?: ComponentChildren
}) {
  const id = useId()
  return (
    <div class="cn-stack cn-gap-8">
      <div class="cn-row cn-between">
        <label for={id} class="cn-label">
          {props.label}
        </label>
        <span class="cn-row">
          {props.extra}
          <output for={id} class="cn-meta">
            {props.display}
          </output>
        </span>
      </div>
      <input
        id={id}
        type="range"
        class="fd-range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        disabled={props.disabled}
        aria-valuetext={props.display}
        onInput={(e) => props.onInput(Number(e.currentTarget.value))}
      />
    </div>
  )
}

export function Toggle(props: {
  label: string
  checked: boolean
  onChange(checked: boolean): void
  disabled?: boolean
}) {
  return (
    <label class="choice">
      <input
        type="checkbox"
        class="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      {props.label}
    </label>
  )
}

export function Segmented<T extends string | number>(props: {
  label: string
  options: { value: T; label: string; hint?: string }[]
  value: T
  onChange(value: T): void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div class="cn-stack cn-gap-8">
      <span id={id} class="cn-label">
        {props.label}
      </span>
      <div class="segmented" role="group" aria-labelledby={id}>
        {props.options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={props.value === o.value}
            disabled={props.disabled}
            onClick={() => props.onChange(o.value)}
          >
            <b>{o.label}</b>
            {o.hint && <small>{o.hint}</small>}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Select<T extends string | number>(props: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange(value: T): void
}) {
  const id = useId()
  return (
    <div class="field">
      <label for={id}>{props.label}</label>
      <select
        id={id}
        value={String(props.value)}
        onChange={(e) => {
          const raw = e.currentTarget.value
          const hit = props.options.find((o) => String(o.value) === raw)
          if (hit) props.onChange(hit.value)
        }}
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Section of the control panel with a heading. */
export function Section(props: { title: string; children: ComponentChildren }) {
  const id = useId()
  return (
    <section class="cn-stack cn-gap-16 cn-p-16" aria-labelledby={id}>
      <h2 id={id} class="cn-name cn-m-0">
        {props.title}
      </h2>
      {props.children}
    </section>
  )
}
