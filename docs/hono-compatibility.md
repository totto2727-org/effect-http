# Hono 機能対応表

## 判定基準

比較元は [Hono 4.13.18](https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823)、比較先は [Effect 4.1.4](https://github.com/Effect-TS/effect/tree/3e2030b43e86a60113f2f32671076ff3b1d84ce4) である。
この表は Hono の `src/middleware` 全27ディレクトリと `src/helper` 全14ディレクトリを起点にする。
関連する JSX、validation、HTTP API 機能も別表で扱う。

- **追加**: Effect に不足する、再利用可能な HTTP の判定・ポリシーを本パッケージが提供する。
- **Effect を利用**: インターフェイスや細かい仕様が違っても、Effect の既存機能で目的を概ね満たせるため追加しない。
- **対象外**: Hono の Context、ルーター、レンダラー、実行環境、アプリケーション固有の方針に依存するため追加しない。

専用ミドルウェアがないことだけを理由に、新しいラッパーを追加しない。
「Effect を利用」は Hono と完全互換という意味ではない。
「追加」は Hono の全オプションを移植する意味ではなく、下記の対象範囲と安全側の差分を持つ。
参照元と継続的な更新方針は [upstream-differences.md](./upstream-differences.md) に記録する。

## 組み込みミドルウェア

各 Hono 名は固定コミットの実装へリンクする。

| Hono                          | 対応          | 本パッケージの方針、または追加しない理由                                                                                                                                            |
| ----------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [basic-auth][h-basic]         | Effect を利用 | `HttpApiSecurity.basic` と `HttpApiMiddleware` で認証を構成する。固定ユーザーの照合や challenge の違いだけのために重複 API を作らない。                                             |
| [bearer-auth][h-bearer]       | Effect を利用 | `HttpApiSecurity.bearer` とアプリケーションの認証サービスを使う。scheme 宣言だけで認証済みになるとは扱わない。                                                                      |
| [body-limit][h-body]          | Effect を利用 | `HttpIncomingMessage.MaxBodySize`、stream の byte 制限、decompression の上限を使う。本文読み取り時の制限であり、未読の body まで常に handler 前に検査する Hono 互換ゲートではない。 |
| [cache][h-cache]              | 追加          | `ResponseCache` が有界の GET レスポンスキャッシュを提供する。`CacheControl` が HTTP の保存可否を扱う。汎用 `effect/Cache` 単体では認証、Cookie、Vary、HTTP freshness を判定しない。 |
| [combine][h-combine]          | Effect を利用 | `Effect` の合成・条件分岐・エラー回復と `HttpRouter.middleware` を使う。Hono の `next()` 制御を移植しない。                                                                         |
| [compress][h-compress]        | Effect を利用 | `HttpMiddleware.compression` と `decompression` を使う。algorithm の優先順位や threshold の違いは許容する。                                                                         |
| [context-storage][h-context]  | Effect を利用 | `Context` と request service を使う。Effect の外から Hono Context を同期取得する互換機能は作らない。                                                                                |
| [cors][h-cors]                | Effect を利用 | `HttpMiddleware.cors` を使う。Hono の context-aware callback と完全には一致しない。                                                                                                 |
| [csrf][h-csrf]                | 追加          | `Csrf` が Origin と Fetch Metadata の拒否ポリシー、および純粋な判定関数を提供する。CORS によるレスポンス公開制御は CSRF の拒否処理ではない。                                        |
| [etag][h-etag]                | 追加          | `ConditionalRequest` が任意の有界なメモリ上のレスポンスへ validator と条件付き応答を適用する。Effect の `Etag` 型と静的ファイル用機能は再実装しない。                               |
| [ip-restriction][h-ip]        | Effect を利用 | request の peer address と `effect/net/IpNetwork` の parse・contains を組み合わせる。forwarded header は信頼する proxy の設定がある場合だけ使う。                                   |
| [jsx-renderer][h-jsx]         | 対象外        | Hono JSX と Context に結合したレンダラーであり、HTTP 基盤の不足ではない。                                                                                                           |
| [jwk][h-jwk]                  | Effect を利用 | `effect/jose/Jwks` と `Jwt.verifyWithKeySet`、`HttpApiSecurity` を使う。HTTP 認証 glue の差だけのために暗号機能を増やさない。                                                       |
| [jwt][h-jwt]                  | Effect を利用 | `effect/jose/Jwt` の検証・claim validation を使う。token の decode と署名検証は区別する。                                                                                           |
| [language][h-language]        | Effect を利用 | ヘッダーの照合は本パッケージの `Accepts` を使える。query、cookie、path の優先順位と結果の保存は既存 request API を使うアプリケーションの方針とする。                                |
| [logger][h-logger]            | Effect を利用 | `HttpMiddleware.logger` と Effect の logging を使う。ログの行数や書式の互換性は求めない。                                                                                           |
| [method-not-allowed][h-405]   | 対象外        | 自動 `Allow` 算出はルーターの route inventory に依存する。Effect の route 定義と明示的な405応答を使い、Hono の404後処理を移植しない。                                               |
| [method-override][h-override] | 対象外        | form や query で HTTP method を書き換える互換機能は提供しない。必要なアプリケーションで許可 method と CSRF の方針を明示する。                                                       |
| [mount][h-mount]              | Effect を利用 | `HttpEffect.fromWebHandler` と router の prefix を使う。Hono の env や executionCtx は再現しない。                                                                                  |
| [powered-by][h-powered]       | Effect を利用 | header setter で十分であり、専用 API は作らない。`SecureHeaders` は情報漏えいを減らすため、このヘッダーを除去する。                                                                 |
| [pretty-json][h-pretty]       | Effect を利用 | JSON の整形とレスポンス生成で概ね実現できる。任意の下流 body を query 次第で読み直すミドルウェアは作らない。                                                                        |
| [request-id][h-id]            | Effect を利用 | `Context`、`crypto/SecureRandom` の UUID、logging annotation、trace context を組み合わせる。trace ID と `X-Request-Id` が同一契約だとは扱わない。                                   |
| [secure-headers][h-secure]    | 追加          | `SecureHeaders` が既定の安全なヘッダー群と CSP のポリシーをまとめる。単なる `setHeader` の別名ではなく、重複設定と危険な値を境界で扱う。                                            |
| [serve-static][h-static]      | Effect を利用 | `HttpStaticServer.make/layer`、`HttpPlatform`、`Etag` を使う。既存の MIME、cache-control、range、conditional request を複製しない。                                                 |
| [timeout][h-timeout]          | Effect を利用 | `Effect.timeout`、`timeoutOrElse` と HTTP error mapping を使う。Effect の interruption を失う timer race を追加しない。                                                             |
| [timing][h-timing]            | Effect を利用 | Effect の Clock、tracing、logging を使う。必要な `Server-Timing` の公開内容はアプリケーションが決める。                                                                             |
| [trailing-slash][h-slash]     | Effect を利用 | router の `ignoreTrailingSlash`、明示 redirect、静的配信の redirect を使う。Hono の404依存の canonicalization は移植しない。                                                        |

## ヘルパー

| Hono                     | 対応          | 本パッケージの方針、または追加しない理由                                                                                                                                         |
| ------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [accepts][h-accepts]     | 追加          | `Accepts` を文字列、Web の request/header、および Effect request から使えるようにする。未一致を明示し、拒否された値を無条件の default で返さない。                               |
| [adapter][h-adapter]     | Effect を利用 | `Config`、`Context`、`Layer` と実行環境別 platform を使う。runtime 自動判定は追加しない。                                                                                        |
| [conninfo][h-conninfo]   | Effect を利用 | request の remote address を使う。port や address family の Hono 共通型を新設しない。                                                                                            |
| [cookie][h-cookie]       | Effect を利用 | request.cookies、`Cookies`、response の set/expire と `crypto/Mac` を使う。署名 cookie の convenience API だけのために暗号・Cookie API を再包装しない。                          |
| [css][h-css]             | 対象外        | CSS-in-JS、keyframes、Hono JSX との統合は別のレンダラー領域である。                                                                                                              |
| [dev][h-dev]             | 対象外        | Hono router の表示・検査 API は移植しない。Effect の route 定義と HttpApi/OpenAPI を利用する。                                                                                   |
| [factory][h-factory]     | Effect を利用 | `HttpRouter`、`HttpApiBuilder`、`Context`、`Layer` の型付き合成を使う。Hono の型推論補助 factory は不要である。                                                                  |
| [html][h-html]           | 対象外        | Hono 固有の tagged template と raw/callback モデルは移植しない。Effect の HTML response や `Template` 自体が HTML エスケープを保証するとは扱わず、選択したレンダラーで対処する。 |
| [proxy][h-proxy]         | Effect を利用 | `HttpClient`、request.toClientRequest、response.fromClientResponse を使う。信頼する転送先と hop-by-hop header の方針はアプリケーション境界で管理する。                           |
| [route][h-route]         | Effect を利用 | `HttpRouter.RouteContext` の route、prefix、params を使う。Hono の複数 middleware match 履歴は再現しない。                                                                       |
| [ssg][h-ssg]             | 対象外        | 静的サイト生成は HTTP ミドルウェア補完ではない。Effect の static server は生成器とは区別する。                                                                                   |
| [streaming][h-streaming] | Effect を利用 | `Stream`、response.stream、`encoding/Sse` と `HttpApiSchema.StreamSse` を使う。callback writer の形式差は許容する。                                                              |
| [testing][h-testing]     | Effect を利用 | `HttpApiTest`、`HttpServer` の test client、`HttpEffect.toWebHandler` を使う。独自 test client は追加しない。                                                                    |
| [ws][h-ws]               | Effect を利用 | request upgrade と `socket/Socket` を使う。Hono の event callback model や runtime adapter を再実装しない。                                                                      |

## 関連機能と対象外のエコシステム

| Hono の機能群                      | 対応             | 理由                                                                                                    |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| JSX、JSX DOM、JSX streaming        | 対象外           | UI レンダラー、Context、browser DOM に依存する。                                                        |
| validator と Zod 系 middleware     | Effect を利用    | `Schema` と HttpApi の request/response schema を使う。外部 schema engine を標準依存にしない。          |
| typed client、RPC、OpenAPI、API UI | Effect を利用    | `HttpApiClient`、`HttpApi`、OpenAPI、Swagger/Scalar、RPC の既存機能を使う。                             |
| 実行環境別 adapter                 | 対象外           | Node、Bun、Web handler など Effect 側の platform を優先する。追加は実環境で不足が確認された場合に限る。 |
| 外部 `@hono/*` middleware          | 今回の比較対象外 | 独立したサービス連携を無制限に列挙しない。Sentry や Firebase などは具体的な利用要件が生じた時に調べる。 |

## Effect 側の根拠

- [HTTP の公開 export 一覧](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/index.ts) と [HttpMiddleware](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/HttpMiddleware.ts) が CORS、圧縮、logger、tracer、trusted proxy を提供する。
- [HttpStaticServer](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/HttpStaticServer.ts#L75-L283) は静的ファイルの conditional response と range を提供する。
- [Etag](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http/Etag.ts#L76-L149) の Generator はファイルの metadata 起点であり、任意の JSON body を hash する機能とは異なる。
- [HttpApiMiddleware](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/http-api/HttpApiMiddleware.ts#L71-L108)、[Jwt](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/jose/Jwt.ts#L331-L380)、[Jwks](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/jose/Jwks.ts#L179-L296) を認証の既存機能として扱う。
- [IpNetwork.contains](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/net/IpNetwork.ts#L414-L440) が CIDR 判定を提供する。
- [Cache](https://github.com/Effect-TS/effect/blob/3e2030b43e86a60113f2f32671076ff3b1d84ce4/packages/effect/src/Cache.ts) は汎用保存基盤であり、レスポンスの HTTP ポリシーは本パッケージが補う。

## バージョン境界

本パッケージの対応対象は Effect 4 の `effect/http` と `effect/http-api` である。
Effect 3 の `@effect/platform` を対象にした互換レイヤーは提供しない。
参考比較した Effect 3 のコミットは `a67af3d016d40ad1f46a182c22e160c5346389c0` で、`effect` 3.22.4 と `@effect/platform` 0.97.3 を含む。
Effect 4 の圧縮、JOSE、静的配信が存在することを、Effect 3 にも同じ API がある証拠として使わない。

[h-basic]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/basic-auth
[h-bearer]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/bearer-auth
[h-body]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/body-limit
[h-cache]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/cache
[h-combine]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/combine
[h-compress]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/compress
[h-context]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/context-storage
[h-cors]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/cors
[h-csrf]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/csrf
[h-etag]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/etag
[h-ip]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/ip-restriction
[h-jsx]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/jsx-renderer
[h-jwk]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/jwk
[h-jwt]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/jwt
[h-language]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/language
[h-logger]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/logger
[h-405]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/method-not-allowed
[h-override]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/method-override
[h-mount]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/mount
[h-powered]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/powered-by
[h-pretty]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/pretty-json
[h-id]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/request-id
[h-secure]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/secure-headers
[h-static]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/serve-static
[h-timeout]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/timeout
[h-timing]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/timing
[h-slash]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/middleware/trailing-slash
[h-accepts]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/accepts
[h-adapter]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/adapter
[h-conninfo]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/conninfo
[h-cookie]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/cookie
[h-css]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/css
[h-dev]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/dev
[h-factory]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/factory
[h-html]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/html
[h-proxy]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/proxy
[h-route]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/route
[h-ssg]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/ssg
[h-streaming]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/streaming
[h-testing]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/testing
[h-ws]: https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/helper/websocket
