# Hono インポートパス別対応表

## 比較元と全件性

この文書は一時レポートではなく、リポジトリで追跡し配布物にも含める対応方針である。
API の単位は名前付き関数ではなく、`hono` パッケージの公開インポートパスとする。
比較元は [Hono 4.13.18 の package.json](https://github.com/honojs/hono/blob/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/package.json)、比較先は [Effect 4.1.4](https://github.com/Effect-TS/effect/tree/3e2030b43e86a60113f2f32671076ff3b1d84ce4) である。
Hono の比較コミットは `f6fbaf0299c48eea9e656e03e2ffe7ac755e8823` で固定する。

`package.json#exports` の宣言は77件で、固定パス76件と `./utils/*` のパターン1件からなる。
[Hono のビルド設定](https://github.com/honojs/hono/blob/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/vite.config.ts) は `src/**/*.ts` を個別出力し、`*.test.ts` と `*.test.tsx` を除外する。
この規則で `./utils/*` に対応する実在モジュールを展開すると28件になる。
したがって、具体的な公開インポートパスは **76 + 28 = 104件** であり、以下に104行を記録する。
ワイルドカードはディレクトリ区切りにも一致するため、`hono/utils/jwt/jws` のような深いパスも含める。
`hono/utils/jwt` と `hono/utils/jwt/index` は同じ実装に到達するが、別のインポートパスなので両方を記録する。
型だけを公開するモジュール、deprecated な adapter、ルートモジュールも省略しない。

| 区分                                  | 具体的パス数 |
| ------------------------------------- | -----------: |
| 本体・型・request・client・validation |            9 |
| 組み込みミドルウェア                  |           27 |
| ヘルパー                              |           14 |
| ルーター                              |            6 |
| JSX・DOM                              |           10 |
| 実行環境別 adapter                    |            9 |
| utils と JWT の再公開                 |           29 |
| 合計                                  |          104 |

外部パッケージの `@hono/*` は `hono` 自身の公開インポートパスではないため、この104件には含めない。
`hono/package.json` と `hono/context` はこの比較元の `exports` に宣言されておらず、公開パスとして追加しない。

## 判定基準

- **追加**: 既存 Effect と effront が提供していない、汎用 HTTP ポリシーだけを本パッケージで提供する。
- **Effect を利用**: 表に記載した Effect API または Web 標準 API で目的を概ね満たせるため、同じラッパーを追加しない。
- **effront を利用**: effront のアプリケーション、描画、配信、実行環境統合の領域であり、本パッケージでは対応しない。
- **対象外**: Hono 固有の実装契約またはアプリケーション固有の方針であり、各行に追加しない具体的な理由を記す。

専用ミドルウェア名がないことを不足の根拠にしない。
「Effect を利用」は Hono と同じ関数名、戻り値、オプション、細かな仕様を保証するものではない。
「追加」は記載した範囲の実装であり、Hono の全オプションの移植ではない。
表中の `Http*`、`Cookies`、`Etag`、`Headers`、`Mime`、`Url`、`UrlParams` は、別記しない限り `effect/http` の namespace export を指す。
`HttpApi*` と `OpenApi` は `effect/http-api`、`Effect`、`Context`、`Schema`、`Data`、`Clock`、`Layer`、`Logger`、`Stream`、`Scope` は `effect` から参照する。
`SecureRandom`、`Digest`、`Mac`、`Signature` は `effect/crypto`、`Base64`、`Base64Url`、`Sse` は `effect/encoding`、`Socket` は `effect/socket`、`Path` は `effect` の `Path` を指す。
request instance の field と namespace の関数は区別して記載する。
effront がカバーする機能は、Effect に同等機能があるかどうかに関係なく本パッケージでは実装しない。
参照コミットと更新方針は [upstream-differences.md](./upstream-differences.md) に記録する。

## 本体・型・request・client・validation: 9件

| Hono インポートパス   | 判定           | 具体的な対応先                                                                                                                                            | 対応方針・追加しない理由                                                                                                                   |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `hono`                | effront を利用 | `@effront/core` の `Application.effront()`、Effect の `HttpRouter` と `HttpApiBuilder`                                                                    | アプリケーション、ルーティング、middleware 合成は effront または Effect で定義する。Hono クラスと Context の互換フレームワークを作らない。 |
| `hono/request`        | Effect を利用  | `effect/http` の `HttpServerRequest`、`HttpServerRequest.schemaBodyJson`、`HttpServerRequest.schemaBodyMultipart`、`HttpServerRequest.schemaSearchParams` | request、body、query、cookie、header は既存 request service から読む。`HonoRequest` の本文キャッシュや `.valid()` の互換型は追加しない。   |
| `hono/types`          | 対象外         | Effect の `Effect<A, E, R>`、`Context`、`HttpRouter`、`HttpApi` の型                                                                                      | Hono の `Env`、`MiddlewareHandler`、route schema 型は Hono の型推論契約であり、Effect 側の型を使う。Hono 型の再定義はしない。              |
| `hono/hono-base`      | effront を利用 | `@effront/core` の `Application.effront()`、Effect の `HttpRouter`                                                                                        | Hono の基底アプリケーションクラスを再現しない。effront のアプリケーション構成と Effect の router を使う。                                  |
| `hono/tiny`           | 対象外         | Effect の `HttpRouter`                                                                                                                                    | ルーター構成を変えた Hono のサイズ最適化 preset であり、汎用 HTTP ポリシーではない。Effect 用の Hono tiny preset を作らない。              |
| `hono/quick`          | 対象外         | Effect の `HttpRouter`                                                                                                                                    | Hono の起動性能向け preset であり、Effect の router を使う。Hono の内部ルーター組み合わせを複製しない。                                    |
| `hono/http-exception` | Effect を利用  | `Data.TaggedError`、`Effect.catch`、`HttpServerResponse`、`HttpApiSchema`                                                                                 | typed error を境界で HTTP response/status に変換する。throw ベースの `HTTPException` と `getResponse()` の互換クラスは作らない。           |
| `hono/client`         | Effect を利用  | `effect/http-api` の `HttpApiClient`、`effect/http` の `HttpClient`                                                                                       | 型付き API client と通常の HTTP client は既存 API を使う。Hono のアプリケーション型から client を導く契約は移植しない。                    |
| `hono/validator`      | Effect を利用  | `Schema`、`HttpServerRequest.schemaBodyJson`、`schemaBodyForm`、`schemaHeaders`、`HttpApiEndpoint`                                                        | decode と request/response schema を既存 API で定義する。Hono Context の validated data 保存先は不要である。                               |

## 組み込みミドルウェア: 27件

| Hono インポートパス       | 判定           | 具体的な対応先                                                                                                           | 対応方針・追加しない理由                                                                                                                                                                      |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hono/basic-auth`         | Effect を利用  | `HttpApiSecurity.basic`、`HttpApiMiddleware`                                                                             | 基本認証を宣言し、アプリケーションの認証サービスで照合する。固定ユーザー照合や challenge 書式の違いだけのために別 API を作らない。                                                            |
| `hono/bearer-auth`        | Effect を利用  | `HttpApiSecurity.bearer`、`HttpApiMiddleware`                                                                            | token の検証を認証サービスへ委ねる。scheme 宣言だけで認証済みになるとは扱わない。                                                                                                             |
| `hono/body-limit`         | Effect を利用  | `HttpIncomingMessage.MaxBodySize`、`HttpMiddleware.decompression`、`Stream`                                              | body 読み取りと展開後のサイズを制限する。未読 body まで常に handler 前に検査する Hono 互換ゲートは作らない。                                                                                  |
| `hono/cache`              | 追加           | 本パッケージの `ResponseCache`、`CacheControl`                                                                           | 公開 GET の有界メモリキャッシュを提供する。Authorization、Cookie、保存禁止、未宣言 Vary、stream は保守的に迂回する。effront のページ、Flight 応答、静的配信をキャッシュし直す機能は作らない。 |
| `hono/combine`            | Effect を利用  | `Effect` の合成・条件分岐・エラー回復、`HttpRouter.middleware`                                                           | Effect の成功、失敗、環境型を保つ合成を使う。Hono の `next()` 制御を移植しない。                                                                                                              |
| `hono/compress`           | Effect を利用  | `HttpMiddleware.compression`、`HttpMiddleware.decompression`                                                             | 既存の圧縮・展開を使う。algorithm の優先順位や threshold の違いは許容する。                                                                                                                   |
| `hono/context-storage`    | Effect を利用  | `Context`、`HttpServerRequest.HttpServerRequest`                                                                         | request-local service を Effect の環境として渡す。Effect の外で Hono Context を同期取得する互換機能は作らない。                                                                               |
| `hono/cors`               | Effect を利用  | `HttpMiddleware.cors`                                                                                                    | 既存 CORS を使う。Hono の context-aware callback と同じインターフェイスは要求しない。                                                                                                         |
| `hono/csrf`               | 追加           | 本パッケージの `Csrf.decide`、`Csrf.middleware`                                                                          | Origin と Fetch Metadata を照合し unsafe method を拒否する。CORS の公開制御とは区別する。effront 固有の Server Function 処理を再実装する機能は追加しない。                                    |
| `hono/etag`               | 追加           | 本パッケージの `ConditionalRequest`、Effect の `Etag`                                                                    | 任意の有界なメモリ上の GET 応答へ validator と条件付き応答を適用する。Effect と effront が提供する静的ファイルの ETag、range、304 は再実装しない。                                            |
| `hono/ip-restriction`     | Effect を利用  | `HttpServerRequest.HttpServerRequest` の `remoteAddress`、`effect/net` の `IpNetwork.fromString` と `IpNetwork.contains` | peer address と CIDR の parse・contains を組み合わせる。forwarded header は信頼する proxy を境界で明示した場合だけ読む。                                                                      |
| `hono/jsx-renderer`       | effront を利用 | `@effront/core` の `Application.effront()`、`@effront/vite`                                                              | React RSC、SSR、layout、hydration は effront に任せる。Hono JSX と Context に結合した renderer は移植しない。                                                                                 |
| `hono/jwk`                | Effect を利用  | `effect/jose` の `Jwks`、`Jwt.verifyWithKeySet`、`HttpApiSecurity`                                                       | key set の取得と token 検証は既存 JOSE を使う。認証 middleware の接続差だけのために暗号機能を増やさない。                                                                                     |
| `hono/jwt`                | Effect を利用  | `effect/jose` の `Jwt`、`HttpApiMiddleware`                                                                              | 署名と claim の検証を既存 API で実施する。decode を認証とは扱わない。                                                                                                                         |
| `hono/language`           | Effect を利用  | 本パッケージの `Accepts`、`HttpServerRequest`、`Cookies`                                                                 | Accept-Language の再利用可能な照合だけを `Accepts` で補う。query、cookie、path の優先順位と結果保存は既存 request API を使うアプリケーション方針とする。                                      |
| `hono/logger`             | Effect を利用  | `HttpMiddleware.logger`、`Effect.log`、`Logger`                                                                          | HTTP logging と構造化 logging を使う。Hono のログ書式や行数に合わせる wrapper は作らない。                                                                                                    |
| `hono/method-not-allowed` | 対象外         | `HttpRouter` と `HttpServerResponse` による明示的な405応答                                                               | 自動 `Allow` 算出は router の route inventory と404後処理に依存する。Hono router の履歴探索は移植せず、アプリケーションが許可 method を定義する。                                             |
| `hono/method-override`    | 対象外         | アプリケーションの明示的な routing と CSRF 方針                                                                          | form/query から HTTP method を書き換える互換機能は追加しない。使用する場合の許可 method と認証境界はアプリケーションが決める。                                                                |
| `hono/mount`              | Effect を利用  | `HttpEffect.fromWebHandler`、`HttpRouter` の prefix                                                                      | Web handler の取り込みと prefix routing を使う。Hono の env と executionCtx の互換性は提供しない。                                                                                            |
| `hono/powered-by`         | Effect を利用  | `HttpServerResponse.setHeader`、`removeHeader`                                                                           | 任意の識別 header は既存 setter で十分である。`SecureHeaders` は情報漏えいを減らすため `X-Powered-By` を除去する。                                                                            |
| `hono/pretty-json`        | Effect を利用  | `HttpServerResponse.text` と `JSON.stringify`                                                                            | 必要な箇所で JSON を整形して content type を指定する。query 次第で任意の下流 body を読み直す専用 middleware は作らない。                                                                      |
| `hono/request-id`         | Effect を利用  | `effect/crypto` の `SecureRandom.SecureRandom` の `uuidV4`、`Context`、`Effect.annotateLogs`、`HttpMiddleware.tracer`    | request ID を生成・保存・ログへ伝播する。trace ID と `X-Request-Id` が同じ契約とは扱わない。                                                                                                  |
| `hono/secure-headers`     | 追加           | 本パッケージの `SecureHeaders`                                                                                           | 安全な既定値と CSP/HSTS の opt-in 設定を提供する。effront の renderer、nonce の埋め込み、React integration は実装しない。                                                                     |
| `hono/serve-static`       | effront を利用 | `@effront/server/assets` の `withAssets`、Effect の `HttpStaticServer`、`HttpPlatform`                                   | effront の client/public assets を既存配信経路で扱う。静的ファイルの MIME、cache-control、range、conditional response を再実装しない。                                                        |
| `hono/timeout`            | Effect を利用  | `Effect.timeout`、`Effect.timeoutOrElse`、HTTP error mapping                                                             | interruption を保つ既存 timeout を使う。別の timer race を作らない。                                                                                                                          |
| `hono/timing`             | Effect を利用  | `Clock`、`Effect.withSpan`、`Effect.log`、`HttpServerResponse.setHeader`                                                 | 計測、tracing、ログを使い、必要な `Server-Timing` の内容だけをアプリケーションが決める。Hono の Context 上の timing registry は作らない。                                                     |
| `hono/trailing-slash`     | Effect を利用  | `HttpRouter.RouterConfig` の `ignoreTrailingSlash`、`HttpServerResponse.redirect`                                        | route matching または明示 redirect で対応する。Hono の404後処理に依存した canonicalization は移植しない。                                                                                     |

## ヘルパー: 14件

| Hono インポートパス | 判定           | 具体的な対応先                                                                                                                          | 対応方針・追加しない理由                                                                                                                                                     |
| ------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hono/accepts`      | 追加           | 本パッケージの `Accepts.parse`、`negotiate`、`negotiateHeaders`、`negotiateRequest`、`negotiateEffect`                                  | 文字列、Web Headers/Request、Effect request で同じ交渉ロジックを使う。未一致を `None`、構文違反を `ParseError` とする。effront の HTML/Flight プロトコル判定は置き換えない。 |
| `hono/adapter`      | effront を利用 | `@effront/core/workers`、`@effront/cloudflare/workers`、Effect の `Config` と `Layer`                                                   | host と bindings は host integration から注入する。Hono の runtime 自動判定と env 取得の互換層を作らない。                                                                   |
| `hono/conninfo`     | Effect を利用  | `HttpServerRequest.HttpServerRequest` の `remoteAddress`、実行環境別 HTTP server                                                        | peer address は既存 request/server から取得する。host が提供しない port と address family を推測した Hono 共通型は新設しない。                                               |
| `hono/cookie`       | Effect を利用  | `HttpServerRequest.HttpServerRequest` の `cookies`、`Cookies`、`HttpServerResponse.setCookie`、`expireCookie`、`effect/crypto` の `Mac` | cookie の parse・serialize・更新は既存 API を使う。署名 cookie は MAC service と組み合わせ、convenience API だけのために再包装しない。                                       |
| `hono/css`          | effront を利用 | `@effront/tailwind` の `effrontTailwind`、React/effront の stylesheet integration                                                       | styling は effront の UI/build 領域で扱う。Hono CSS-in-JS の tagged template、keyframes、flush model は別契約なので移植しない。                                              |
| `hono/dev`          | 対象外         | `HttpApi` と `OpenApi`、effront の Vite 開発環境                                                                                        | Hono router の表示・検査は Hono 固有である。API description と UI 開発は既存の定義・開発環境を利用し、Hono route dump は作らない。                                           |
| `hono/factory`      | effront を利用 | `@effront/core` の `Application.effront()`、Effect の `HttpApiBuilder`、`Context`、`Layer`                                              | 型付き app/handler の定義は既存 composition API に任せる。Hono factory の Context 型推論を再現しない。                                                                       |
| `hono/html`         | effront を利用 | React rendering と `@effront/core`、HTTP 出力には `HttpServerResponse.html`                                                             | HTML escaping と rendering は選択した React/effront renderer へ任せる。Effect の HTML response 自体が escaping を保証するとは扱わず、Hono の raw/callback 契約も移植しない。 |
| `hono/proxy`        | Effect を利用  | `HttpClient`、`HttpServerRequest.toClientRequest`、`HttpServerResponse.fromClientResponse`                                              | request/response の変換と転送を既存 API で組み立てる。転送先と hop-by-hop header の信頼方針はアプリケーション境界に置く。                                                    |
| `hono/route`        | Effect を利用  | `HttpRouter.RouteContext`                                                                                                               | 現在の route、prefix、params を取得する。Hono の複数 middleware match 履歴は再現しない。                                                                                     |
| `hono/ssg`          | 対象外         | 採用するサイト生成・build pipeline                                                                                                      | 静的サイト生成は HTTP middleware 補完の範囲ではない。effront の SSR と静的 assets 配信を SSG の実装済み証拠とは扱わず、ここにも生成器を追加しない。                          |
| `hono/streaming`    | Effect を利用  | `Stream`、`HttpServerResponse.stream`、`Sse`、`HttpApiSchema.StreamSse`                                                                 | バックプレッシャーと中断を保つ既存 stream/SSE を使う。effront の RSC/SSR streaming は effront に任せ、callback writer を再実装しない。                                       |
| `hono/testing`      | Effect を利用  | `HttpApiTest.groups`、`HttpServer.makeTestClient` と `layerTestClient`、`HttpEffect.toWebHandler`                                       | 既存の API test と実 Web Request 経路を使う。Hono app 型に依存する test client は追加しない。                                                                                |
| `hono/ws`           | Effect を利用  | `HttpServerRequest.HttpServerRequest` の `upgrade`、`HttpServerRequest.upgradeChannel`、`effect/socket` の `Socket`                     | upgrade と socket の既存処理を使う。Hono の event callback model と runtime adapter は再実装しない。ソースディレクトリ名は `helper/websocket` だが公開パスはこの名前である。 |

## ルーター: 6件

| Hono インポートパス          | 判定          | 具体的な対応先                         | 対応方針・追加しない理由                                                                                                     |
| ---------------------------- | ------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `hono/router`                | Effect を利用 | `HttpRouter`、effront の `Application` | router の interface と route 定義は採用する HTTP framework の型を使う。Hono の `Router` interface の互換契約は追加しない。   |
| `hono/router/reg-exp-router` | 対象外        | `HttpRouter`                           | Hono の正規表現 router 実装であり、HTTP ポリシーではない。Effect の router の代替アルゴリズムとして移植しない。              |
| `hono/router/smart-router`   | 対象外        | `HttpRouter`                           | Hono router の自動選択・切り替えは Hono 内部実装の問題である。Effect 上で同じ router selection layer を作らない。            |
| `hono/router/trie-router`    | 対象外        | `HttpRouter`                           | Hono の trie 実装を重複させず、Effect の router に任せる。route pattern の細かな差は許容する。                               |
| `hono/router/pattern-router` | 対象外        | `HttpRouter`                           | Hono の pattern matching router は移植しない。Effect の route 定義で表現できない要件があればアプリケーション側で具体化する。 |
| `hono/router/linear-router`  | 対象外        | `HttpRouter`                           | Hono の線形探索 router は実装しない。サイズや探索方式の preset を追加することは本パッケージの目的ではない。                  |

## JSX・DOM: 10件

| Hono インポートパス            | 判定           | 具体的な対応先                                                  | 対応方針・追加しない理由                                                                                                 |
| ------------------------------ | -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `hono/jsx`                     | effront を利用 | React と `@effront/core`、`@effront/vite`                       | UI component、SSR、Server Components は effront の領域である。Hono JSX renderer を追加しない。                           |
| `hono/jsx/jsx-dev-runtime`     | effront を利用 | React の `react/jsx-dev-runtime` と effront の Vite integration | 開発時の JSX 変換は React toolchain を使う。Hono の開発用 JSX runtime は不要である。                                     |
| `hono/jsx/jsx-runtime`         | effront を利用 | React の `react/jsx-runtime` と effront の Vite integration     | JSX の自動 runtime は React toolchain に任せる。本パッケージで compiler runtime を提供しない。                           |
| `hono/jsx/streaming`           | effront を利用 | effront の RSC/SSR streaming、React Suspense                    | UI の Suspense と streamed HTML は effront に任せる。HTTP の汎用 `Stream` と Hono JSX streaming の互換性は混同しない。   |
| `hono/jsx/dom`                 | effront を利用 | React DOM と effront の browser hydration/navigation            | DOM rendering と component state は UI framework の責務である。Hono の browser renderer を移植しない。                   |
| `hono/jsx/dom/jsx-dev-runtime` | effront を利用 | React の開発用 JSX runtime と effront の browser build          | DOM 用の開発 runtime も React 側を使う。Hono の DOM node factory を提供しない。                                          |
| `hono/jsx/dom/jsx-runtime`     | effront を利用 | React の JSX runtime と effront の browser build                | client component の JSX 変換は既存 build に任せる。別の DOM JSX runtime は追加しない。                                   |
| `hono/jsx/dom/client`          | effront を利用 | React DOM client と effront の client entry                     | client mounting、hydration、navigation は effront に任せる。Hono の client renderer API を再現しない。                   |
| `hono/jsx/dom/css`             | effront を利用 | `@effront/tailwind` と effront の stylesheet integration        | browser 側の style integration は UI/build の責務である。Hono の DOM CSS-in-JS と style insertion の互換実装は作らない。 |
| `hono/jsx/dom/server`          | effront を利用 | effront の React SSR と RSC server entry                        | server rendering は effront に任せる。Hono DOM 用の server rendering 互換 API は追加しない。                             |

## 実行環境別 adapter: 9件

これら9パスは比較元では deprecated だが、まだ公開されているため全件記録する。
外部 `@hono/*` への移行先が存在することを、Effect または effront が同じ実行環境を実装済みである証拠とは扱わない。

| Hono インポートパス       | 判定           | 具体的な対応先                                                                                     | 対応方針・追加しない理由                                                                                                                                                  |
| ------------------------- | -------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hono/cloudflare-workers` | effront を利用 | `@effront/core/workers` の `createFetchHandler`、`@effront/cloudflare/workers`                     | Fetch handler、typed bindings、execution context は effront の Worker integration に任せる。Hono の静的配信と WebSocket adapter も本パッケージへ移植しない。              |
| `hono/cloudflare-pages`   | 対象外         | Workers を使う場合は `@effront/cloudflare`                                                         | Pages Functions の `EventContext` と middleware chain は host 固有であり対応しない。effront の Workers 対応を Pages Functions 互換とは扱わない。                          |
| `hono/deno`               | 対象外         | 汎用 Fetch 境界には `HttpEffect.toWebHandler`                                                      | Deno のファイル配信、SSG、WebSocket upgrade、接続情報 adapter は提供しない。Fetch 変換が使えることを Deno host integration の全実装とは扱わない。                         |
| `hono/bun`                | effront を利用 | `@effront/server/bun` の `serve`、`@effront/server/assets` の `withAssets`、Effect の Bun platform | Bun の listener と静的配信は既存 host integration に任せる。Hono の SSG と固有 WebSocket callback contract は追加しない。                                                 |
| `hono/aws-lambda`         | 対象外         | HTTP 本体の Web 変換には `HttpEffect.toWebHandler`                                                 | API Gateway/ALB event、Lambda context、streamHandle、binary response の host 変換は本パッケージの対象外である。Web handler だけで Lambda event 互換になるとは記述しない。 |
| `hono/vercel`             | 対象外         | Fetch 対応 host の境界には `HttpEffect.toWebHandler`                                               | Vercel 固有の handler・接続情報 wrapper は追加しない。汎用 Fetch handler と deployment/host integration を区別する。                                                      |
| `hono/netlify`            | 対象外         | Fetch 対応 host の境界には `HttpEffect.toWebHandler`                                               | Netlify の host context と handler adaptation はここで実装しない。effront が Netlify を実装済みとは扱わない。                                                             |
| `hono/lambda-edge`        | 対象外         | アプリケーション側の CloudFront event adapter                                                      | CloudFront の request/response event と callback contract は Web Fetch と異なる。専用 event 変換と deployment adapter は追加しない。                                      |
| `hono/service-worker`     | 対象外         | Web request 処理には `HttpEffect.toWebHandler`                                                     | Service Worker の fetch event 登録と `respondWith` の接続は host 側が行う。listener を暗黙登録する `fire` の互換 API は追加しない。                                       |

## utils と JWT の再公開: 29件

`hono/utils/jwt` は固定 export で、残る28行は `./utils/*` の実在ファイルから展開したパスである。
`utils` という名前を理由に公開 API の列挙から除外しない。

| Hono インポートパス      | 判定           | 具体的な対応先                                                                                                     | 対応方針・追加しない理由                                                                                                                                    |
| ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hono/utils/accept`      | 追加           | 本パッケージの `Accepts.parse` と `Accepts.negotiate`                                                              | 生ヘッダーの parser と交渉を middleware 外から使えるようにする。Hono の parser の戻り値互換ではなく、kind 別構文・q=0・入力上限・明示的エラーを採用する。   |
| `hono/utils/basic-auth`  | Effect を利用  | `HttpApiSecurity.basic`、`HttpApiMiddleware`、必要な生 decode には `Base64`                                        | Authorization の基本認証を既存 security API で扱う。Web Request 専用 parser の convenience wrapper は追加しない。                                           |
| `hono/utils/body`        | Effect を利用  | `HttpServerRequest` の body reader、`schemaBodyForm`、`schemaBodyMultipart`、`Multipart`                           | form と multipart の parse は既存 API で行う。Hono の dotted key 展開と field 配列化の細かな仕様はアプリケーションの Schema で決める。                      |
| `hono/utils/buffer`      | Effect を利用  | Web の `Uint8Array`、`TextDecoder`、`Response.formData`、Effect の `Mac` と `Signature`                            | byte/text/form 変換は標準 API を使う。秘密値の照合は暗号 API の検証へ委ね、通常の byte 比較を timing-safe と称する wrapper は作らない。                     |
| `hono/utils/color`       | 対象外         | 採用する logger の formatter と host 設定                                                                          | terminal color の同期・非同期自動判定は HTTP ポリシーではない。Hono の color detector を移植しない。                                                        |
| `hono/utils/compress`    | Effect を利用  | `HttpMiddleware.compression`                                                                                       | 圧縮可能 content type の判定は既存の圧縮機能に任せる。Hono の正規表現だけを別 API として複製しない。                                                        |
| `hono/utils/concurrent`  | Effect を利用  | `Effect.forEach` の concurrency 設定、`Effect` の scoped concurrency                                               | 並行度と中断を既存 Effect で制御する。Hono の Promise pool を重複実装しない。                                                                               |
| `hono/utils/constants`   | 対象外         | Hono 内部の composed-handler marker は不要                                                                         | Hono が handler の合成済み状態を識別する内部定数であり、Effect の composition に必要ない。互換 marker を追加しない。                                        |
| `hono/utils/cookie`      | Effect を利用  | `Cookies`、`HttpServerResponse.setCookie`、`Mac`                                                                   | parse・serialize と署名検証を既存 API で組み立てる。Hono の cookie 型と prefix/options 契約を再公開しない。                                                 |
| `hono/utils/crypto`      | Effect を利用  | `effect/crypto` の `Digest` と hash algorithm                                                                      | byte/string の digest は既存 service に依存させる。SHA-1/MD5 が存在することを新規の認証・署名用途に推奨する根拠にはせず、暗黙の Crypto runtime も作らない。 |
| `hono/utils/encode`      | Effect を利用  | `effect/encoding` の `Base64` と `Base64Url`                                                                       | Base64/Base64URL の encode/decode は既存 API を使う。戻り値とエラー表現の違いは許容する。                                                                   |
| `hono/utils/filepath`    | Effect を利用  | `HttpStaticServer`、`HttpPlatform`、`Path`                                                                         | ファイル解決は static server の安全な root と path 処理に任せる。effront の assets 解決や Hono の default document helper を再実装しない。                  |
| `hono/utils/handler`     | 対象外         | Effect の型付き composition と effront の handler definition                                                       | 関数の引数数や Hono marker で middleware を識別する処理は Hono 内部契約である。Effect の handler に同じ introspection を導入しない。                        |
| `hono/utils/headers`     | Effect を利用  | `effect/http` の `Headers`、`HttpServerRequest.schemaHeaders`                                                      | header の取得、正規化、型検証は既存 API を使う。Hono の既知 header 名 union を複製しない。                                                                  |
| `hono/utils/html`        | effront を利用 | React/effront の HTML rendering                                                                                    | escaping、raw marker、callback phase は renderer の契約である。Hono の escaped-string brand と callback resolver を本パッケージで実装しない。               |
| `hono/utils/http-status` | Effect を利用  | `HttpStatus.Literal` と `HttpStatus.fromLiteral`、`HttpServerResponse` の status、`HttpApiSchema`                  | status と response schema は既存型を使う。Hono 固有の status union と deprecated な alias は追加しない。                                                    |
| `hono/utils/ipaddr`      | Effect を利用  | `effect/net` の `NetAddress`、`IpNetwork`                                                                          | IPv4/IPv6 の parse・表示・ネットワーク照合は既存 IP 型と API を使う。Hono の bigint 表現と変換関数の互換層は作らない。                                      |
| `hono/utils/jwt`         | Effect を利用  | `effect/jose` の `Jwt` と `Jwks`                                                                                   | sign・verify・decode・key set 検証は既存 JOSE を使う。同じ実装に到達する `hono/utils/jwt/index` とは別パスとして記録する。                                  |
| `hono/utils/jwt/index`   | Effect を利用  | `effect/jose` の `Jwt` と `Jwks`                                                                                   | wildcard で公開される barrel も既存 JOSE へ置き換える。`Jwt` object の Hono 互換再公開は追加しない。                                                        |
| `hono/utils/jwt/jwa`     | Effect を利用  | `effect/jose` の `Jwk.Algorithm`、`Jwk.SigningKey`、`Jwk.VerificationKey`、`effect/crypto` の `Signature` と `Mac` | JWA の algorithm と鍵種別は既存 JOSE/crypto 型で制限する。Hono の enum 名を再現するための定数群は作らない。                                                 |
| `hono/utils/jwt/jws`     | Effect を利用  | `effect/jose` の `Jws`、`Signature`、`Mac`                                                                         | JWS の signing/verifying は既存暗号 API を使う。Hono の key union や Promise wrapper を再包装しない。                                                       |
| `hono/utils/jwt/jwt`     | Effect を利用  | `effect/jose` の `Jwt` と `Jwks`                                                                                   | token/header の decode、署名、claim、key set 検証を既存 API で行う。algorithm と claim の検証を省いた decode を認証に使わない。                             |
| `hono/utils/jwt/types`   | Effect を利用  | `effect/jose` の `JoseError.JoseError`、`Jwt.JwtError`、`Jwt.RegisteredClaims`、`Schema`                           | JWT failure と payload の型は既存 JOSE と Schema で表現する。Hono の例外クラス階層、enum、payload alias をコピーしない。                                    |
| `hono/utils/jwt/utf8`    | Effect を利用  | Web 標準の `TextEncoder` と `TextDecoder`                                                                          | 標準の UTF-8 encoder/decoder を使う。Hono が公開する単一インスタンスと同じグローバルを再公開する必要はない。                                                |
| `hono/utils/mime`        | Effect を利用  | `Mime.getType`、`Mime.getExtension`、`HttpStaticServer`、effront の `withAssets`                                   | 静的配信の MIME 判定は既存配信機能に任せる。Hono の MIME table と拡張子検索 helper を公開し直すことは HTTP ポリシー補完に不要である。                       |
| `hono/utils/mount`       | Effect を利用  | `HttpEffect.fromWebHandler`、`HttpRouter` と Web `Request`                                                         | prefix の取り扱いと外部 Web handler への接続は既存境界で構成する。Hono の sub-application 用 request cloning を移植しない。                                 |
| `hono/utils/stream`      | Effect を利用  | `Stream`、`Scope`、`HttpServerResponse.stream`                                                                     | writer、終了、中断、バックプレッシャーを既存 stream に任せる。Hono `StreamingApi` class の互換 wrapper は作らない。                                         |
| `hono/utils/types`       | 対象外         | TypeScript 標準 utility 型、Effect の型と `Schema`                                                                 | Hono の型推論を補う generic utility 群は HTTP runtime の不足ではない。JSON と request 型は利用する schema/API から導出し、型 helper package を追加しない。  |
| `hono/utils/url`         | Effect を利用  | Web の `URL` と `URLSearchParams`、`HttpServerRequest.toURL`、`Url`、`UrlParams`、`HttpRouter`                     | URL/query の parse と routing は既存 API を使う。Hono の route pattern 分割、optional parameter 展開、decode fallback の互換アルゴリズムは作らない。        |

## effront に委ねる範囲と重複しない境界

比較した effront は [commit `3c8c55c8f99242b0c45c5a672fe3ea22f9e26614`](https://github.com/totto2727-org/effront/tree/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614) である。
本パッケージから effront への runtime 依存は追加しない。
effront が必要なアプリケーションは effront を直接使い、HTTP ポリシーだけが必要なアプリケーションは本パッケージを直接使う。

- `Application.effront()` が返す `Page`、`Routes`、`Layout`、`Component`、`Middleware`、`ServerFn`、`make` をアプリケーション定義に使う。これらをトップレベルの独立 export として記述しない。
- アプリケーション、route、layout、middleware、Server Function、React RSC/SSR、browser hydration/navigation は `@effront/core` と `@effront/vite` の領域である。
- Web Fetch/Workers の接続は `@effront/core/workers` と `@effront/cloudflare`、Node/Bun の listener は `@effront/server/node` と `@effront/server/bun` に任せる。
- client/public assets の静的配信、MIME、range、ファイルの ETag/304 は `@effront/server/assets` の `withAssets` とその基盤の `HttpStaticServer` に任せる。
- stylesheet integration は effront の build と `@effront/tailwind` に任せ、CSS-in-JS runtime は追加しない。
- effront の HTML/Flight 選択とそれに伴う `Vary: Accept`、非公開応答の cache policy を置き換えない。一般の Accept negotiation が必要な別の API には `Accepts` を使える。
- `ResponseCache` は明示的に公開を宣言した別の GET API 用であり、effront の RSC/SSR/Server Function 応答を共有キャッシュするためのものではない。
- `ConditionalRequest` の任意のメモリ上の応答の validator と、effront/Effect の静的ファイル validator を区別する。
- effront の Server Function は既に内部で Origin を検査する。その処理を移植・再実装しない。`Csrf` は独立した HTTP endpoint 用の汎用ポリシーであり、effront の内部検査を同じ設定 API として公開し直すものではない。
- `SecureHeaders` は renderer、nonce integration、Server Function runtime を実装しない。
- effront の将来構想を実装済みの代替とは数えない。SSG と未対応 host の専用 adapter が既に存在するとは記述しない。

## 根拠となる公開 API とソース

Hono の全件性は [package.json#exports](https://github.com/honojs/hono/blob/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/package.json) と [build entry/exclusion](https://github.com/honojs/hono/blob/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/vite.config.ts) を正本とする。
各固定パスの `import` 条件の `dist/` を `src/`、`.js` を `.ts` に対応付けることで、その実装を参照できる。
`./utils/*` は同じ規則で [src/utils](https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/utils) の非テストファイル全28件へ対応する。

- Effect HTTP: [HttpRouter](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/HttpRouter.ts)、[HttpServerRequest](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/HttpServerRequest.ts)、[HttpServerResponse](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/HttpServerResponse.ts)、[HttpEffect](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/HttpEffect.ts)、[HttpMiddleware](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/HttpMiddleware.ts)、[Headers](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/Headers.ts)、[Cookies](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/Cookies.ts)。
- Effect HTTP API: [公開 export](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http-api/index.ts) に `HttpApiBuilder`、`HttpApiClient`、`HttpApiSecurity`、`HttpApiMiddleware`、`HttpApiSchema`、`HttpApiTest`、`OpenApi` がある。
- Effect の静的配信: [HttpStaticServer](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/HttpStaticServer.ts)、[HttpPlatform](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/HttpPlatform.ts)、[Etag](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/Etag.ts)。
- Effect の暗号と JOSE: [crypto 公開 export](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/crypto/index.ts)、[jose 公開 export](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/jose/index.ts)。
- Effect の encoding と IP: [encoding 公開 export](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/encoding/index.ts)、[NetAddress](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/net/NetAddress.ts)、[IpNetwork](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/net/IpNetwork.ts)。
- effront の app と HTTP: [core exports](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/core/package.json)、[core.ts](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/core/src/core.ts)、[http.ts](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/core/src/http.ts)、[Workers handler](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/core/src/workers.ts)、[HTML/Flight と非公開 cache policy](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/core/src/server/application.ts)、[Server Function の Origin 検査](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/core/src/server/server-fn-request.ts)。
- effront の host と assets: [server exports](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/server/package.json)、[assets.withAssets](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/server/src/assets.ts)、[Cloudflare accessors](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/cloudflare/src/workers.ts)、[effrontTailwind](https://github.com/totto2727-org/effront/blob/3c8c55c8f99242b0c45c5a672fe3ea22f9e26614/packages/tailwind/src/plugin.ts)。

## バージョン境界と更新時の検査

本パッケージの対応対象は Effect 4 の `effect/http` と `effect/http-api` であり、Effect 3 の `@effect/platform` 向け互換レイヤーは提供しない。
参考比較した Effect 3 のコミットは `a67af3d016d40ad1f46a182c22e160c5346389c0` で、`effect` 3.22.4 と `@effect/platform` 0.97.3 を含む。
Effect 4 の機能を Effect 3 にも同じ API がある証拠として使わない。

更新時は固定コミットの `package.json#exports` を取得し、全固定パスと、build 規則で生成される wildcard の具体パスを再列挙する。
この文書の第1列と集合比較し、未記載・余分なパス・重複がすべて0件であることを確認する。
全行で具体的な対応先または追加しない理由を確認し、effront と実装範囲が重複しないことを再確認する。
Hono の比較コミット、effront の参照コミット、件数、対応方針を変更した場合は README と upstream 記録も同じコミットで更新する。
