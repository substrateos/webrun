# HTML Target Files

> [!WARNING]
> This is an experimental feature. The API and behavior may change.

`webrun` supports executing logic directly from `.html` files. When you pass an HTML file to `webrun` (or `webrun --test`), `webrun` parses the file and evaluates all script tags in document order. This includes:

- Inline scripts (`<script>` and `<script type="module">`)
- External scripts (`<script src="...">` and `<script type="module" src="...">`)

For external scripts, `webrun` resolves the `src` attribute relative to the original HTML file's location. It also parses the first `<script type="importmap">` to resolve any relative module imports.

## Known Limitation: No DOM Environment

Scripts extracted from HTML files currently execute in webrun's standard sandbox, which is a web worker-style environment. There is no `window`, `document`, `Element`, or any DOM API. This is a significant limitation — code written inside `<script>` tags in an HTML file would very reasonably expect a full browser environment.

The `webrun-skip` attribute exists as a workaround (mark DOM-dependent scripts so webrun ignores them), but this inverts the natural expectation: most code in an HTML file *should* have access to the document it lives in.

### Open Design Questions

**Implementation path.** A DOM environment could be provided via something like [jsdom](https://github.com/jsdom/jsdom), giving each script a parsed document tree derived from the HTML file. This avoids requiring a real browser while still providing the APIs that HTML-embedded code expects.

**Test isolation.** A single shared global `document` would leak state between test functions — one test modifies the DOM, the next test sees the mutation. Most test functions would want a clean environment. This likely means each test function needs its own fresh document instance (parsed from the original HTML), not a shared global. The lifecycle and performance implications of this need more thought.

These questions need resolution before this feature graduates from experiment status.

## Webrun-Exclusive Scripts

Standard web browsers ignore `<script>` tags with unrecognized MIME types. You can use `<script type="module+webrun">` to define scripts that will *only* be evaluated by `webrun` and safely ignored when the HTML is loaded in a browser.

## Skipping Browser-Only Scripts

If you have browser-specific scripts that should not be executed by the headless `webrun` runtime (like DOM manipulation), you can add the `webrun-skip` attribute to explicitly opt-out.

## Example

```html
<!DOCTYPE html>
<html>
<head>
  <script type="importmap">
    {
      "imports": {
        "utils": "./utils.js"
      }
    }
  </script>
  
  <!-- External scripts are automatically resolved and executed -->
  <script src="./setup.js"></script>
  
  <!-- Inline module scripts are executed -->
  <script type="module">
    import { doSomething } from "utils";
    
    export function testHtmlLogic(t, ctx) {
      t.assert(doSomething() === true, "HTML module execution works");
    }
  </script>
  
  <!-- Webrun-exclusive scripts execute here, but are ignored by browsers -->
  <script type="module+webrun">
    console.log("Only webrun sees this!");
  </script>
  
  <!-- Scripts with webrun-skip are ignored -->
  <script type="module" webrun-skip>
    console.log("Only the browser sees this!");
  </script>
</head>
</html>
```

## Testing with HTML

```bash
# Run tests exported from an HTML file
./webrun --test tests/my_test.html

# Batch HTML files from different directories
./webrun --test tests/a.html tests/b.html
```

Test functions exported from `<script type="module">` tags are discovered and executed by the test runner, exactly like `.ts` or `.js` test files.
