# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Personal website (mikhail.wall) built with Hugo. No theme — all templates are custom, in `layouts/`. Deployed to GitHub Pages via GitHub Actions on push to `main` (`.github/workflows/deploy.yml`, Hugo extended 0.157.0, `--minify`). `public/` is gitignored — never commit build output.

## Commands

```bash
hugo server -D        # local dev server with drafts
hugo                  # build to public/
hugo new blog/my-post-title.md   # new blog post
hugo new notes/my-note.md        # new note
```

There are no tests or linters.

## Architecture

- `config.toml` — site config, params (author/social links), and the main menu. Homepage nav items are anchors (`#about`, `#experience`, ...) into `layouts/index.html`; `blog` and `notes` are separate sections. The header nav renders on every page (anchors get a leading `/` off the homepage) and hides `notes` while that section has no published pages.
- `content/blog/` — long-form articles; `content/notes/` — short thoughts. Front matter: `title`, `date`, `draft`, `description`, `tags`.
- `layouts/_default/baseof.html` — base shell; `partials/header.html` and `footer.html`; per-section list templates in `layouts/blog/` and `layouts/notes/`.
- `layouts/_default/_markup/render-codeblock-goat.html` — code fences tagged `goat` are rendered at build time into SVG diagrams via Hugo's `diagrams.Goat`. GoAT quirks learned the hard way: arrows need a shaft of at least two dashes (`-->`, not `->`) to render, and box borders must be exactly aligned column-wise or the diagram breaks.
- All styling lives in one file: `static/css/style.css`. Use the CSS custom properties defined there (e.g. `--accent`) rather than hardcoded colors, and avoid inline styles. The end of the file contains generated chroma syntax-highlighting styles (`hugo gen chromastyles --style=github-dark`, plus `--style=github` with every selector prefixed `[data-theme="light"]`) — regenerate rather than hand-edit those.
- Taxonomy/term pages are disabled in `config.toml` (`disableKinds`); tags render as plain labels, not links.
- Multi-part articles share a `series: "Name"` front matter value; `single.html` lists the parts in date order above the article and links previous/next below it. Don't write "Part N of ..." by hand in the content.
- Social preview images: `layouts/partials/og-image.html` draws each article's title onto `assets/og/article-base.png` at build time (`images.Text`, fonts in `assets/fonts/`); other pages use `static/og-image.png`. The PNGs are rendered from the SVGs beside them at 1200×630 in IBM Plex Mono; re-render the PNG after editing an SVG.
- IBM Plex Mono is self-hosted from `static/fonts/` (latin subset, `@font-face` at the top of `style.css`); there are no Google Fonts requests.

## Conventions

- Visible dates are formatted `YYYY.MM.DD` everywhere on the site.
- Article prose uses a proportional font; monospace is reserved for code.
- Commit messages: Conventional Commits prefixes (`feat:`, `fix:`, `style:`, `chore:`), no co-author trailer.
