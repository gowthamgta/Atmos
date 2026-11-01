# Kralveth Weather

Weather maps for South India: IMD radar, Meteosat satellite and forecast models (Angular 21 with MapLibre).

## Hosting: Cloudflare Pages

Connected to this repository (Cloudflare dashboard, Workers & Pages, Create, Pages, Connect to Git, `gowthamgta/Atmos`, branch `main`):

- Build command: `npm run build`
- Build output directory: `dist/weather-platform/browser`
- Root directory: empty (the repository's root); Node 22 comes from `.node-version`.

`wrangler.toml` gives the output directory and turns on `nodejs_compat`; `functions/` serves `/api/ildn`, `/api/imd-lightning`,
`/api/radar` and `/imd-radar/*` (the Netlify functions in `netlify/functions/`, run through `netlify/cloudflare.js`), `public/_headers`
the headers. Every push to `main` deploys. Netlify still works from `netlify.toml`. To try the Cloudflare build locally:
`npx ng build && npx wrangler pages dev`.

The Android app (`android-app/`, built by `.github/workflows/android.yml`) opens the site full-screen.

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.3.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
