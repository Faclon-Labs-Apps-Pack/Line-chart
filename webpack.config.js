import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMPONENTS = {
  LineChart: './src/components/LineChart/index.ts',
  LineChartConfiguration: './src/components/LineChartConfiguration/index.ts',
};

// ── design-sdk comes from the host ──────────────────────────────────────────
// IOSense serves ONE copy of @faclon-labs/design-sdk as `window.FDS`
// (src/assets/react/design-sdk.global.js). This bundle should contain this
// widget's renderer + configurator and nothing else; every SDK component
// resolves from the host at runtime. Mirrors ColumnChart / CombinedBarLine.
//
// A FUNCTION external is required, not an object entry:
//   * many subpaths, some containing slashes (EmptyState/illustrations/*),
//     which an object key cannot express;
//   * `.css` imports must NOT be externalised — MiniCssExtractPlugin still has
//     to emit this widget's own component CSS.
//
// The host only ships the subpaths listed in its manifest. Importing one that
// is missing yields `undefined` at RUNTIME — a blank widget in production, with
// no error — so fail the BUILD instead. Set FDS_MANIFEST in CI; without the
// manifest this check silently degrades to a warning.
const FDS_MANIFEST = process.env.FDS_MANIFEST
  || path.resolve(__dirname, '../IOSense/src/assets/react/design-sdk.subpaths.json');
let fdsSubpaths = null;
try {
  fdsSubpaths = new Set(JSON.parse(fs.readFileSync(FDS_MANIFEST, 'utf8')).subpaths);
} catch {
  console.warn(`[design-sdk] manifest not found at ${FDS_MANIFEST} — cannot verify `
    + `imported subpaths exist in the host bundle. Set FDS_MANIFEST to enable the check.`);
}

function designSdkExternal({ request }, callback) {
  const m = /^@faclon-labs\/design-sdk(?:\/(.+))?$/.exec(request || '');
  if (!m) return callback();
  const sub = m[1];
  if (sub && sub.endsWith('.css')) return callback();
  if (sub && fdsSubpaths && !fdsSubpaths.has(sub)) {
    return callback(new Error(
      `[design-sdk] '${request}' is not in the host's shared bundle.\n` +
      `  Add it by running \`npm run build:design-sdk -- --scan\` in IOSense and ` +
      `redeploying design-sdk.global.js, or import a subpath that is included.`));
  }
  return callback(null, sub ? `FDS[${JSON.stringify(sub)}]` : 'FDS.__root');
}

export default (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    mode: isProd ? 'production' : 'development',
    entry: isProd ? COMPONENTS : { app: './src/index.tsx' },
    output: {
      path: path.resolve(__dirname, isProd ? 'dist-bundle' : 'dist'),
      filename: isProd ? '[name].bundle.js' : '[name].js',
      globalObject: 'this',
      clean: true,
    },
    externals: isProd
      ? [
        designSdkExternal,
        {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react-dom/client': 'ReactDOM',
          'react-dom/server': 'ReactDOMServer',
          'react/jsx-runtime': 'ReactJSXRuntime',
          'react/jsx-dev-runtime': 'ReactJSXRuntime',
          // Highcharts (the SDK's LineChart engine) is served ONCE by the host
          // as `window.Highcharts`, with its exporting / export-data / full-screen
          // modules loaded there. This widget no longer imports Highcharts
          // directly (see LineChart.tsx) so nothing here resolves a highcharts
          // specifier and no copy is emitted — verify with
          // `grep -ci highcharts dist-bundle/LineChart.bundle.js`. Externalizing
          // the bare + subpath specifiers keeps that guarantee if a future edit
          // re-adds a direct import: it maps onto the single host identity
          // instead of bundling a second Highcharts (which would leave
          // `chart.exporting` undefined — the classic silent-export bug).
          highcharts: 'Highcharts',
          'highcharts/modules/exporting': 'Highcharts',
          'highcharts/modules/export-data': 'Highcharts',
          'highcharts/modules/full-screen': 'Highcharts',
        },
      ]
      : [],
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      // Force a single React instance — design-sdk ships a copy of React inside
      // its own dist/node_modules which otherwise wins module resolution and
      // crashes hooks (e.g. useId returns null).
      alias: {
        react: path.resolve(__dirname, 'node_modules/react'),
        'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
        'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
        'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
        // ── ONE Highcharts identity (dev + any residual direct import) ────────
        // In dev the SDK is bundled (externals empty), so its charts and any
        // direct highcharts specifier must resolve to the SAME ESM copy, or two
        // namespaces coexist and `chart.exporting` ends up undefined. `$` = exact
        // match so `highcharts/esm/*` still resolves normally. Inert in prod
        // (externals map every specifier to window.Highcharts first).
        highcharts$: path.resolve(__dirname, 'node_modules/highcharts/esm/highcharts.js'),
        'highcharts/modules/exporting$': path.resolve(__dirname, 'node_modules/highcharts/esm/modules/exporting.js'),
        'highcharts/modules/export-data$': path.resolve(__dirname, 'node_modules/highcharts/esm/modules/export-data.js'),
        'highcharts/modules/full-screen$': path.resolve(__dirname, 'node_modules/highcharts/esm/modules/full-screen.js'),
      },
    },
    module: {
      rules: [
        // Disable strict ESM "fullySpecified" resolution for .js files in
        // node_modules — needed because @faclon-labs/design-sdk publishes ESM
        // that performs extension-less deep imports (e.g. into
        // @table-library/react-table-library/select).
        {
          test: /\.m?js$/,
          resolve: { fullySpecified: false },
        },
        {
          test: /\.(ts|tsx)$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [
                '@babel/preset-env',
                ['@babel/preset-react', { runtime: 'automatic' }],
                '@babel/preset-typescript',
              ],
            },
          },
        },
        {
          test: /\.css$/,
          use: [
            isProd ? MiniCssExtractPlugin.loader : 'style-loader',
            'css-loader',
          ],
        },
        {
          test: /\.(png|jpg|jpeg|gif|webp|svg)$/i,
          type: 'asset/resource',
          generator: { filename: 'assets/[name][ext]' },
        },
      ],
    },
    plugins: [
      ...(isProd ? [new MiniCssExtractPlugin({ filename: '[name].bundle.css' })] : []),
    ],
    ...(!isProd && {
      devServer: {
        static: path.resolve(__dirname, 'public'),
        port: 3005,
        hot: true,
        open: false,
        historyApiFallback: true,
      },
    }),
  };
};
