# mpl extension

A codemode-only charting tool for pi, ported from [dmmulroy's `.dotfiles`](https://github.com/dmmulroy/.dotfiles/tree/main/home/.pi/agent/extensions/mpl). It draws matplotlib-style charts through [`mpl`](https://github.com/ivarvong/mpl) (a pixel-exact TypeScript port of matplotlib 3.11), writes PNG/SVG files, and returns the PNG as an image block so a codemode script can show it with `image()`.

## Tools

### `mpl_render` (codemode-only, namespace `mpl`)

Renders a chart from a JSON call list. Read `describeNamespace("mpl")` before the first chart — the namespace carries the full spec reference.

```text
Spec: { calls, theme?, rc?, grid?, format?, scale?, name?, tight_layout? }
- calls: [method, [positional args], {kwargs}], applied in order to the current Axes.
  ax.plot(x, y, 'o-', label='a') is ["plot", [x, y, "o-"], { label: "a" }].
- grid: { rows, cols, sharex?, sharey?, width_ratios?, height_ratios? }; ["sca", [i]]
  switches Axes, ["twinx", []] adds a twin. Figure calls take a "fig." prefix
  (fig.suptitle, fig.tight_layout, fig.colorbar, ...).
- theme: "catppuccin-macchiato" (default, dark, shipped as a .mplstyle in styles/),
  "pro-slate", "pro-dark", or any matplotlib style name; rc overrides keys.
- scale: PNG pixel multiplier 0.25–4, default 2 (1440x840 at the default figure size).
- format: "png" (default), "svg", or "both". Files land in ~/.pi/agent/work/charts/<date>/.
```

Special values: `{"$dates": [...]}` / `{"$date": "..."}` for dates, `{"$float": "nan"}` for NaN/Inf, `{"$transform": "axes"}` for `ax.transAxes`, and tick helpers `["$concise_x", []]` / `["$date_x", [locator, kwargs?, fmt?]]`.

Unknown methods and kwargs throw with the offending call index — the method names are checked against an allow-list of Axes/Figure drawing methods, so a spec can't reach anything else.

## Layout

```
extensions/mpl/
├── index.ts    # mpl_render tool definition + mpl namespace instructions
├── render.ts   # spec -> PNG/SVG files (no pi imports; tests drive it directly)
├── replay.ts   # replays the call list onto an mpl Figure (method allow-list)
└── styles/     # bundled .mplstyle themes (catppuccin-macchiato)
```

## Tests

`tests/mpl/mpl.test.ts` (run via `pnpm test`) covers theme listing, the Axes method allow-list, value decoding, grid+date rendering in all three bundled themes, error reporting with call indices, and the tool's image output.
