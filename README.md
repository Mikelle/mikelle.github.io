# mikhail.wall

Personal website built with Hugo.

## Local Development

```bash
# Install Hugo (macOS)
brew install hugo

# Run local server
hugo server -D

# Build
hugo
```

## Adding Content

### New Blog Post

```bash
hugo new blog/my-post-title.md
```

Then edit `content/blog/my-post-title.md`:

```markdown
---
title: "My Post Title"
date: 2025-01-10
draft: false  # change to false to publish
description: "Short description for the list"
tags: ["tag1", "tag2"]
---

Your markdown content here...

## Heading

Regular paragraph.

- List item
- Another item

`inline code`

```go
// code block
func main() {}
```⁣
```

### New Note

```bash
hugo new notes/my-note.md
```

Then edit `content/notes/my-note.md`:

```markdown
---
title: "Short title for the note"
date: 2025-01-10
tags: ["tag1"]
---

Your note content. Keep it short — these are thoughts, not articles.
```

## Deployment

Push to `main` branch. GitHub Actions will automatically build and deploy to GitHub Pages.

## Structure

```
site/
├── config.toml          # Site config
├── content/
│   ├── blog/            # Blog posts (markdown)
│   └── notes/           # Notes (markdown)
├── layouts/             # HTML templates
├── static/
│   └── css/style.css    # Styles
└── .github/
    └── workflows/
        └── deploy.yml   # Auto-deploy
```
