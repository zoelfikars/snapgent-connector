# Tutorial

Write the English tutorial in this file. It is shown in the dialog of the Info button.

## Writing images

Put the image files in `extension/tutorial/images/` (shared by all languages), then write a line of its own like this:

@gambar(agent-off.jpg)
@gambar(agent-off.jpg, width=300)
@gambar(agent-off.jpg, height=50%)
@gambar(agent-off.jpg, width=300, height=200)

A side that is left out follows the picture's proportions. A size is in pixels (`300`) or a percentage (`50%`).

## Other formats

- **Bold** and `code` inside a sentence
- Bulleted and numbered lists
- Headings with `#`, `##`, `###`
