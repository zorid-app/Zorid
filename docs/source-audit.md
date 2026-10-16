# Shipped-source audit coverage

Snapshot: 2026-10-16. **This is an audit inventory, not a completed code audit or parity claim.** The requested scope includes every shipped desktop and Android code path, including third-party libraries, workers, native helpers, and lazy resources. Current behavior analysis covers only selected portions. Nothing in this ledger certifies full feature, UI, UX, plugin, storage, performance, or lifecycle equivalence.

Only factual names, lengths, hashes, and findings are stored here. Recovered implementation, CSS, reference assets, and decompiled artifacts remain outside project source. User-approved use of a modern Android API baseline does not remove other Android behavior requirements.

## Status and reproducibility

- **uninspected:** identity/inventory only; no bounded semantic reading is documented. Hashing or recognizing a filename does not inspect its behavior.
- **partial:** some syntax, declarations, relationships, or behavior branches were examined; substantial file/module scope remains open.
- **focused:** a narrow named question was answered by static inspection, such as version metadata. It does not mean the complete artifact or its runtime behavior was audited.
- No artifact has an “audit complete” status. All code still needs the relevant behavioral verification and implementation mapping.

This pass reread the existing REA skill and JavaScript guide, reused exported REA evidence, compared every recovered desktop file to its recovery-manifest size/hash, and hashed the listed installed-app/APK entries. These are ordinary metadata operations, **not new REA semantic analysis**. Source files were not executed. SHA-256 identifies exact bytes, not provenance, signatures, functionality, licensing conclusions, or runtime reachability. Payload/launcher paths below are relative to their distinct extraction roots; APK paths are ZIP members.

## Reference boundaries

| Boundary | Identity | Inventory and scope |
| --- | --- | --- |
| Updated desktop payload | Obsidian 1.14.4 ASAR, `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f` | 368 recovered files; full per-file metadata in [payload recovery manifest](/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4/_recovery-manifest.json). |
| Installed desktop launcher | Launcher 1.7.4 ASAR, `0a31162efe161023def5390fb00ef75e21cd9dc1cc71bda328508e2e8f2f8dc1` | 44 recovered files, including native addons; [launcher recovery manifest](/private/tmp/zorid-reference-20261016/recovered/electron-launcher/_recovery-manifest.json). Distinct from payload version. |
| Installed macOS host | `/Applications/Obsidian.app/Contents` | Outer framework/helper/configuration inventory below. Framework metadata reports Electron 31.6.0; actual loaded runtime has not been measured. |
| Android package | `Obsidian-1.14.4.apk`, `b3e5bfa107bb01c4c121d810622ff2de03fd298f55fcf6268b9db50186f192a3` | 1,830 ZIP members; package `md.obsidian`, versionName 1.14.4, code 389. Code/configuration/native rows below; full archive inventory is retained in REA. |
| Other distributions | Not supplied | iOS IPA/native source, Windows/Linux installers, alternative desktop launchers, downloaded community plugins/themes and remote services are not inspected. Cross-platform claims cannot be inferred from this macOS/Android pair. |

The 368-file payload manifest and 44-file launcher manifest both matched the current recovered bytes in this pass. Files beginning `_recovery-manifest` are generated analysis metadata, not shipped source. A full archive inventory is not a full code inventory inside bundled JavaScript, DEX, native libraries, serialized snapshots, or packed resource containers.

## Retained REA coverage

| Evidence | Actual coverage | Explicit limitation |
| --- | --- | --- |
| E1 `ev_32ee7d1a52a3881d94d24654206e1c2b5acb425f2ec1fbc76814a57a7b057dfa` | [rea-application.json](/private/tmp/zorid-reference-20261016/rea-application.json): 38 analyzer-relevant payload files inventoried | Helper startup failed; **zero JavaScript files parsed**. The 38 is the analyzer's selection, not the 368-member whole payload. |
| E2 `ev_ac5b6f0769f47603747fcf2abec7a2980bedf7d986b23bd9323df29b9cde7501` | [rea-main-cache.json](/private/tmp/zorid-reference-20261016/rea-main-cache.json): selected `package.json` and `main.js`; one JS file parsed, 28,792 AST nodes, 87 findings | Partial graph and cleanup limitation; other source assets excluded. Two BrowserWindow and 47 main-side IPC observations do not establish complete contracts. |
| E3 `ev_a023c82af045a4b5acedab1eab958db521c3828491a6320c1f7ee85152573b37` | [rea-renderer-bundle.json](/private/tmp/zorid-reference-20261016/rea-renderer-bundle.json): selected `package.json` and `app.js`; one JS parsed, 195 bundle factories, 1,123,389 AST nodes, 404 findings | Expanded semantic graph exceeded result memory budget. No complete function/call-site audit or runtime execution. |
| Android `ev_42dad07afbf7c91b8d8011cf7e05b13f32cc83da2024ecf78354ef4b96a9ffcc`, inventory `ev_90bd2cb53a47511858df33ce3b4ad304c2af7a8d82c12035710bcabfeed4623d` | [rea-apk-inventory.json](/private/tmp/zorid-reference-20261016/rea-apk-inventory.json): archive inspection/member inventory | This bundle also retains prior desktop records; their presence is **not Android JavaScript analysis**. ZIP inventory does not analyze DEX methods or native ELF code. |
| Android package-code request | REA `inspect_android_package` returned `capability_unavailable` / `unsupported_provider` | Caller-supplied `jadx-headless-mcp` 0.7.1 JAR absent. No JADX decompilation occurred. Independent declaration parsing is separately labeled below. |

Complete retention of an Evidence record means that record was preserved; it does not remove the producer's partial-coverage limits. Summary projections are not independent analyses. See [reference-evidence.md](reference-evidence.md) for detailed provenance and limits.

## Desktop payload code, configuration, styles and UI strings

Root: `/private/tmp/zorid-reference-20261016/recovered/obsidian-1.14.4`. The table includes every recovered `.js`, `.mjs`, `.cjs`, `.wasm`, `.json`, `.css`, `.html`, `.ts`, and `.svg` asset, plus all `i18n/` text records. This includes deferred libraries, worker code, preview/help surfaces, translation data, and vector assets; package entry points alone are insufficient.

| Artifact-relative path | Bytes | SHA-256 | Status | Existing evidence / remaining scope |
| --- | ---: | --- | --- | --- |
| `app.css` | 668,223 | `866e50ac84dd8ad2775e0047ebd3ec5bd03e5af722aff259e6c4ea3cec42d7ba` | uninspected | [Open audit work](#open-audit-work) |
| `app.js` | 3,942,126 | `958ce57fe22f87fdf121546e46dfccd9c8ee971ce3fd8f801d60d4ece39a2df9` | partial | [Editor](editor-reference.md), [attachments](attachment-reference.md), [Bases](bases-reference.md), [Evidence](reference-evidence.md) |
| `enhance.js` | 13,229 | `dae6559565e737174c7063a16f7214a2795330e0262577d3ecc59a1b53caebd8` | uninspected | [Open audit work](#open-audit-work) |
| `help.html` | 565 | `f6d22540c9bf1c1f7b1bfe6c839c76c625c4fc6f9aca8547d802249993a4d4e7` | uninspected | [Open audit work](#open-audit-work) |
| `help.js` | 399,153 | `44d4088f18e8ecf2cb8de940b5fa21d08b855b0673710c89a587fcc106d295c9` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/am.txt` | 127,562 | `0d39887c52d1a2be7a32436db2d2d1c6822c9db2ed2d03f25cfc3fb1e03ae8b1` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ar.txt` | 118,825 | `2d58f4ec74a6f13fdd9a4382d014818a1ad8d254e13486b15384f34a4d9f8d0e` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/be.txt` | 145,128 | `e8353ad105825e2b4485020c1d965b8005f769185ba1c85e852b66e6abd7e811` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/bg.txt` | 156,569 | `1368fdc35ed257a2f9dc114d7a5e7bedd3753ccf626fb57ab0c726affdbb432c` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/bn.txt` | 192,482 | `04bd248d6d6ab54f9285aad702bbd5acb8d8e2d023c713c55106e956ffe52057` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ca.txt` | 89,893 | `2353a7bf7234957faa2abc88f95cd947b8d034c14523edcb1ded5f7bb3923678` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/cs.txt` | 86,806 | `7a038617ad2af56b3f4db1a2c58e6fb3e078c8c6bda28c0ae66214ccb855aed0` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/da.txt` | 76,562 | `5224521fdcb34d3ae13e8ee0d6724bac57bd4a88a37b03306d7ae9c92c8d5bd3` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/de.txt` | 90,333 | `3da558bb192dd66d993f32b9d7ee990c23335dcbecdd62e946fdab57dba8b005` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/el.txt` | 159,867 | `ed9de3d34bbaa54c9636355e297521bc3e82363c8d3e9fdf720654500b2d13cb` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/en-GB.txt` | 7,594 | `9500380e4ea74da7566713c2ecf4bd2888ca03a21c88db0af42a06d63c1fe9b8` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/es.txt` | 88,438 | `299edf9ae857b3af56dde7524d6c89cbd6ceda9fb4ce608fddf541359f425595` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/fa.txt` | 132,294 | `5a46679f7da22022b7e88af866309faf24c3c6df5123caaf46735a5f2b517394` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/fi.txt` | 82,312 | `2658ee9aa4b4555a40a1552999bc8919c070b6750c0548bd258cc34403ea9c9b` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/fr.txt` | 95,033 | `d52df106b205d749e2dd4a99355701628f9b354c6bc214b664e774d7bfe1ace5` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ga.txt` | 89,729 | `7f5082f561b5f598aa3094182a142273387d4ff36936304c337b6ae4f3d19a1b` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/gl.txt` | 87,163 | `66068c3ad710fd44dec6f2da2d825dca414f791c640ace9e6a6fda8036e68dd2` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/he.txt` | 105,053 | `324db79afa2c07137c5a3ae3f3cb27659929b3ac28104fa5090a9fd4826004a3` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/hu.txt` | 96,297 | `cc07ccbea51368cbe0bd03f6632049183df057ee1e84e8624e8888c3d536b37c` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/id.txt` | 78,667 | `28de5622c6a471debc7e8f0d106732576e8d8ac6a690822ea55b7324ad390bdd` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/it.txt` | 84,903 | `dc68a5c8ed269ac127bf482cb786a7ac4882bbc5857ccaaedd67582162daae7e` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ja.txt` | 113,042 | `fdc396c89ef69ca26570f1d5daf7d25a3a20723d909773d9959edef053adf4c6` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ka.txt` | 205,986 | `b637059a5e0977620e7e822dcdd59385e4e2b138682a9f3574720bfd3a0fa8fa` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/kab.txt` | 84,835 | `044dcd24f59382cbb8ad260f17f51e2c53832c86c0da3bf70199a0821556f019` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/km.txt` | 204,384 | `d07e170bdd652983e4ba95ee56b1f100ddf51ab8bd856b736e6c2e95e26209ea` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ko.txt` | 96,091 | `66b595f331eab921dc498c7ef5a935ec760a7a1139d7d5a641f98867d957966d` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/lv.txt` | 86,529 | `76ff3c1acc632342e836682601547608225c7bc7cad894d96cd9c826d7ef7dc6` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/mapping.txt` | 98,599 | `6e8aaf7c4527bf4d74822c748439ecee21f84341fb8e1e89747e1f7547ba116a` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ms.txt` | 80,335 | `cf98c5cdd361f2132e06c37f6d42f3519237d1a0861248190f6d99e2285986ab` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ne.txt` | 209,244 | `258e62584bc5da2284ef8dea20a081ddff240176b6b4f6c4fd31b8085a6757f5` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/nl.txt` | 83,697 | `a6b861e3c0339af10c9ba775b5a741e5e1023a54d4a78002141827c64eb1f618` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/no.txt` | 76,481 | `53f105c356c8af97f43be691469de35ac5317d52ae58e56022e96fb223bdb198` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/pl.txt` | 85,920 | `05b8dab6655f53289bd91801d4a12f85e8cb506d8a2385e38e1d549044728eb9` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/pt-BR.txt` | 85,577 | `64a9248e39de0ed63d990f4addb53d0cb5fd491271c5bc521bc769c8595548cd` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/pt.txt` | 86,037 | `67a1bba4490897ecbaa139a985863e46c094f89deba10aed694d71e641aa8a59` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ro.txt` | 93,059 | `0eb9e3752f8efaf3eaaa45ae300943e074c35b0d91f71f3d785969f221864ae8` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ru.txt` | 150,240 | `c78c34ff3c3685eb6620218c88df8da20a9d8c71838901df0502d393d175f96b` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/sa.txt` | 215,692 | `876c2f983b7877fdfda1ba500eaa33f6395ff42cf41307870dec4b326ab5efdf` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/si.txt` | 200,310 | `01218e10de43b83869abdaac05f7680658ec43c956fc38e11ab72f7b1be0a44b` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/sk.txt` | 89,189 | `b14bb9267e0c3e1057308f6b1c79d02054938ab4029c3b7cf6de916603fb3288` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/sq.txt` | 91,808 | `16b1405f994b5e58456856ec4de816b2c58d2f89ab55c9817875874208d510d9` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/sr.txt` | 140,592 | `072feb4748e0ca41de2a98115b16615586afcbfeedee0f38b9f277c3b5902e82` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/sv.txt` | 80,158 | `0e39848372c145ec985f56d220f4052655f1127f71e0344b449573594861a56d` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/ta.txt` | 214,669 | `23068af430cf632d6544e40fdf11946e9e23ebc91ea5e916607f324325800762` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/th.txt` | 180,818 | `3d81082bac57a0c694ae53f9031a37be45244cf291807abb4a465f960d4bdd0f` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/tr.txt` | 86,404 | `0f3b00d0c49b93af8beddc9fbcaf358eed7f87fa507e0c0eb86d291860c2e1fa` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/uk.txt` | 143,740 | `958f797a88be8e43ffb3918cc0324d4273c47e18de5238d761bb461b98ee15de` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/uz.txt` | 88,508 | `03783c7972d1154049efc49e380da49c41f25033b75d4a0ce81f9a735181978a` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/vi.txt` | 103,547 | `4b319efd4e672ead6823ce0f3a3adfd98c0ee460eb58f360d20c09fbfa84ea84` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/zh-TW.txt` | 69,816 | `cbfec71ff9e281172eeb4ed91a4db4a56a0a88df3f31e16d178b42b85ead37a3` | uninspected | [Open audit work](#open-audit-work) |
| `i18n/zh.txt` | 70,913 | `8bff243410824995a17ed730e8bfcc423d2c0e3ad88d8ad8126f4c21a188b1e1` | uninspected | [Open audit work](#open-audit-work) |
| `i18n.js` | 132,996 | `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713` | uninspected | [Open audit work](#open-audit-work) |
| `index.html` | 1,445 | `48b72d620f92677a3dbbc3e91786fc939bbe54d572162eedd3ee938a4f40024f` | uninspected | [Open audit work](#open-audit-work) |
| `lib/codemirror/cm-addons.js` | 58,679 | `fa370184a49e72482751cbdd253ad7821ec11ce1e92da39f0a232568504334b1` | uninspected | [Open audit work](#open-audit-work) |
| `lib/codemirror/codemirror.js` | 400,161 | `2150c2e30dcc28427b0cacb31c8073e2f8cdbeb1b03d61214a7200809bf21a43` | uninspected | [Open audit work](#open-audit-work) |
| `lib/codemirror/markdown.js` | 45,052 | `b339279a0496b870dbf8dd61397610eb8c9755feb5643301cd713114f70bdc32` | uninspected | [Open audit work](#open-audit-work) |
| `lib/codemirror/meta.min.js` | 12,792 | `97f787318cca86f26348148ed84ed2510b190a868b86363adb24cdd78a33fcfb` | uninspected | [Open audit work](#open-audit-work) |
| `lib/codemirror/modes.min.js` | 562,656 | `016713740d2428f9686a173cb4614c3a611ace8a9a25db8dab4ed30e9c77a745` | uninspected | [Open audit work](#open-audit-work) |
| `lib/codemirror/overlay.js` | 3,099 | `4f158e3ba838c18621c62a8f42524db718f75974c6ad042bf9e9b828e35e0155` | uninspected | [Open audit work](#open-audit-work) |
| `lib/codemirror/vim.js` | 248,977 | `2e1c8efa02fd4e4794e91567955e9c8821a311e18bb7798923d9b8ecece73636` | uninspected | [Open audit work](#open-audit-work) |
| `lib/defuddle.full.js` | 750,220 | `6860b24acdc776a32d3aea78f90e5cb8cea2488b144321f0c06fc8cc8c418128` | uninspected | [Open audit work](#open-audit-work) |
| `lib/i18next.min.js` | 41,340 | `7980f21b960a94e89dd35cbc429be1f25eaf4a76220d96252d83b0c70301de4f` | uninspected | [Open audit work](#open-audit-work) |
| `lib/mathjax/obsidian-mathjax.js` | 1,139,224 | `ac00d774192009417b8fa50412f4b27f94426014e7526fe1151276a9784de965` | uninspected | [Open audit work](#open-audit-work) |
| `lib/mermaid.min.js` | 2,964,042 | `6ef73c979e4636b0724eb3b4ee505e53e3a117e4cae31914ec5b2d64f27ff603` | uninspected | [Open audit work](#open-audit-work) |
| `lib/moment.min.js` | 375,043 | `b19e17770b1673aca44065e7dc2c393d306559871b99bfe885a0d10d4f2798cf` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-check.svg` | 415 | `9a680f1212888ede7dcae6bfc8cafc447babf4ce531271c8d07277b0aedade96` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-comment.svg` | 883 | `c58b385b4a0be6de822a3262b8191073d1730f6420368bd9c6d80db7312327ff` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-help.svg` | 2,168 | `74d9bba0814d12f5ae2715189e1747b7edf5ff6d82c4ca75bae86d717319b6eb` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-insert.svg` | 408 | `b2153e2c88c62179029ea9876d463216529ecf581b77d52c971a2cdf3d3166c6` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-key.svg` | 1,452 | `5772b8dd158b0f02bb2be689bb680f4903d84e202cb29a3dc0560af53134c6ba` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-newparagraph.svg` | 426 | `a583cca122263d94c3eebfefe83c965a1b305b9c84e5aa3c5ba10527941db7db` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-noicon.svg` | 158 | `76399e70d311834d11ab2d6239118b36847d79a78d7655b1f839d51c811304cf` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-note.svg` | 1,041 | `11a75c9f233dd3e5e3500edcdd733358394f28395337616e8b0430694bf0dba1` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-paperclip.svg` | 552 | `0213c8baed4f8c497881ffed0e49abb309291d51725aaf1a0a757174b4999368` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-paragraph.svg` | 1,143 | `efbcd2a6cfb4581dad74a1c09ad43cf2b8245611e5b19c966317da948f2bcb7c` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/images/annotation-pushpin.svg` | 1,375 | `22197186d18445959e5fe5577d8e34440b31d87c811daf47318078310c0c5530` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/pdf.min.mjs` | 566,729 | `f298004f6e2f4e67faab473513f322edc506295968e96b50041cb1a69ea90279` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/pdf.viewer.min.mjs` | 488,821 | `7060308a7ffa11ab3112458ec58f740eb90643849beeaa6d9c9ff4441e9d35af` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/pdf.worker.min.mjs` | 1,130,698 | `0235bc7b0c7822334edb2f82eb2ffc7954b971e4c7e57acca4703f6c2555efe4` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/version.json` | 65 | `0a8ac68bb7f1845ad8eb795e7147abf66f75c79b5e585c5985dbad4d42ad1eec` | focused | [Attachments](attachment-reference.md#pdf-metadata) — metadata only |
| `lib/pdfjs/wasm/openjpeg.wasm` | 257,382 | `cb031f36245b389e1f5bffc59d10eed35bb0f85d7368b46c3f0b462042ec8e9e` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/wasm/openjpeg_nowasm_fallback.js` | 462,316 | `53c228428a8861035a34738966af263fc9d4cee6df25a0ad942af947469a0bd9` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pdfjs/wasm/qcms_bg.wasm` | 94,519 | `6017eca5939cde1836e88e6d8cd27ae039246f206515ea4487bdfd0e3fb16e26` | uninspected | [Open audit work](#open-audit-work) |
| `lib/pixi.min.js` | 487,134 | `842814b22c348dcdab381ffb79da3763ff0672271f60f09dababa52656fd31b8` | uninspected | [Open audit work](#open-audit-work) |
| `lib/prism.min.js` | 576,531 | `9389ca2110991b037228c190018c94abcf25d1af0ad32fc51b78263660acbddb` | uninspected | [Open audit work](#open-audit-work) |
| `lib/readability.d.ts` | 1,621 | `128e1d29cfcd436e5949a7c67dd3dd4f6412b0f45095fd02a175f1deed213638` | uninspected | [Open audit work](#open-audit-work) |
| `lib/readability.js` | 32,556 | `b17dea4bd122b5f0c32b6d55801607ea1492292f14aba9d97448f1fde395a2ef` | uninspected | [Open audit work](#open-audit-work) |
| `lib/reveal/black.css` | 6,980 | `67439d656fa1c04ebaef2f252729b954524a55de79afb4a399749eae063b1d74` | uninspected | [Open audit work](#open-audit-work) |
| `lib/reveal/reveal.css` | 46,725 | `cb3c0deb593f2f6527a5955f47a3f6e2c192b2bed35fb52231c95966e2d2d727` | uninspected | [Open audit work](#open-audit-work) |
| `lib/reveal/reveal.js` | 89,690 | `b82b9b79b9052fb447f74c2b6f63b1d2d906b419a8a7f648d70418418bd7daf2` | uninspected | [Open audit work](#open-audit-work) |
| `lib/reveal/white.css` | 6,967 | `2dae508dd0677cc750605df1a62d8cf90754a5ea80f1d00f446d4f5e49af5e72` | uninspected | [Open audit work](#open-audit-work) |
| `lib/scrypt.js` | 17,877 | `437b12082063e4d09d2e3704a9fcb398feaef4978e9c4969bfb1d00cfd433676` | uninspected | [Open audit work](#open-audit-work) |
| `lib/turndown.js` | 10,697 | `f552fd2818a9d3c0ad6fa9f47524c52b4966a9d9a31e68cfaf05196c6cd773f2` | uninspected | [Open audit work](#open-audit-work) |
| `main.js` | 203,702 | `5d90e3738f7db8fb8ea00d01556d71310fd557c4a3c785601274c2bb875a2cba` | partial | [Evidence](reference-evidence.md) — E2 IPC/window AST subset |
| `package.json` | 260 | `c8e13b2b7067519b90eae036f3ec3c078a4f192fa2d1e25ee3f77d65956b2c00` | focused | [Evidence](reference-evidence.md) — package metadata only |
| `public/images/2308ab1944a6bfa5c5b8.svg` | 278 | `a44ac4cbf79c6765f4bdc3a0dc3fb51b56ed5eb4679177f0a40f04b63b3e3a3c` | uninspected | [Open audit work](#open-audit-work) |
| `public/images/6155340132a851f6089e.svg` | 315 | `a7c6a118d17f6a296037b519e9891e08951de59c289fe41ec2596a63c3b28516` | uninspected | [Open audit work](#open-audit-work) |
| `quicklook/index.html` | 595 | `dbafa1cc34533d2f9a59b7ad28d4e9ea1aafe128870b800d4e72307d06022f1c` | uninspected | [Open audit work](#open-audit-work) |
| `quicklook.css` | 117,038 | `1d41faed51a4acd642446b3123c511aa16d4a001d3055807f520cd6aa9905b3c` | uninspected | [Open audit work](#open-audit-work) |
| `quicklook.js` | 679,096 | `e5d3b4108abbef063b8a5b9215190f622c29d3e3f3961c57a4e4d5dd15a0911a` | uninspected | [Open audit work](#open-audit-work) |
| `sim.js` | 17,693 | `549be2f69710af360d521c92b80c83718f673594d3dc2255a65e251199eee25d` | uninspected | [Open audit work](#open-audit-work) |
| `starter.html` | 568 | `e2e114b2d705fa9bb77d135199ce5fd0eeb7e51a2aaa9dbeac952978034a5eac` | uninspected | [Open audit work](#open-audit-work) |
| `starter.js` | 461,410 | `3d2587ec4d30a13bffca40129c4e8b3838bb6fcdaa0ce09ad4a6325a4c860333` | uninspected | [Open audit work](#open-audit-work) |
| `worker.js` | 239,777 | `a42f7927658132927e124131fdb7fc69fdb2853097c24158e0fdb245b87c34ae` | uninspected | [Open audit work](#open-audit-work) |

Listed 109 payload assets. The remaining 259 files stay uninspected; their exact paths, bytes and hashes are in the full recovery manifest linked above. They are not silently treated as audited.


| Remaining payload resource family | Files | Bytes | Audit status |
| --- | ---: | ---: | --- |

| Finder metadata | 5 | 32,788 | uninspected; no parsing/rendering/translation equivalence established |

| Fonts | 45 | 2,527,239 | uninspected; no parsing/rendering/translation equivalence established |

| Other resource/license files | 10 | 58,804 | uninspected; no parsing/rendering/translation equivalence established |

| PDF CMaps | 168 | 1,165,667 | uninspected; no parsing/rendering/translation equivalence established |

| Sandbox/example Markdown | 31 | 22,731 | uninspected; no parsing/rendering/translation equivalence established |


The grouped fonts, CMaps, ICC data and examples can affect rendering and user flows. They remain part of the broader parity work. Counting them separately avoids pretending that hundreds of resource blobs are JavaScript functions. Their omission from the expanded code table is a presentation choice, not completion.

## Desktop launcher and bundled addon inventory

Root: `/private/tmp/zorid-reference-20261016/recovered/electron-launcher`. All 44 recovered launcher members are listed, including native `.node` addons, shipped C/Objective-C++/header/build files, remote bridge code and manifests. The launcher `main.js` is a different artifact from the payload `main.js` analyzed by E2.

| Artifact-relative path | Bytes | SHA-256 | Status | Existing evidence / remaining scope |
| --- | ---: | --- | --- | --- |
| `main.js` | 13,222 | `72f68e4e249f3b9750d2eb7bd93977e9e335b42b1e855e1d424a7966957dc1e2` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/common/get-electron-binding.js` | 441 | `f857a19eec43c9f8d97736c86057064c5b71fc14f6e773d1d7b1c268598bd309` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/common/ipc-messages.js` | 77 | `d43aa81f5bc89faa359e0f97c814ba25155591ff078fbb9bfd40f8c7c9683230` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/common/module-names.js` | 1,520 | `dfcea2c5575d2db51cb38b22c6b4958337746e6d75ba827f450a57b196856c16` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/common/type-utils.js` | 4,050 | `4e4e7bda21b242e517b9b1b582a15a45e8135bc7f7b1f0e9b33e56181dea3ee8` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/main/index.js` | 535 | `ae4b7e86235189c9a7ee079f4a7bddf7baacbdcc7d213f853ac32bc7ddeafcde` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/main/objects-registry.js` | 4,442 | `0312d21bd8da83d0384deab4c87cf7d8f3bbfa8424cd65e07e259d3044afd8d9` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/main/server.js` | 21,822 | `520423ed3cad887c987493d4a8617dc8086223ace4e67cffd71beffbcda8e7a7` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/renderer/callbacks-registry.js` | 2,104 | `14db4469fabeed645433a21fabe124f07a7b46e115829b170e9bb16aa77d5992` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/renderer/index.js` | 793 | `f459072159108ef7cc53cb8ca2bb1ce32d752393808165df92ef3708cfe01f54` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/dist/src/renderer/remote.js` | 15,820 | `f495b4730d590ae7f52361f973b639041b78ed457477ce52333c2ab8e3045c43` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/LICENSE` | 1,070 | `fc9ae4f3237a307eb111ef8f55bef41d90857e8d1500e592feb4e48639de7a82` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/main/index.js` | 45 | `289679196b4b9ea379488a1e810e108f697b7c7e4e4c3a303f403af35482eb87` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/@electron/remote/package.json` | 900 | `5fcbbaf53286aee1bfadaa002ff5da0ce8c3d5e2f0a11679f3075ed3f4962fd2` | focused | [Evidence](reference-evidence.md) — manifest metadata only |
| `node_modules/@electron/remote/renderer/index.js` | 49 | `2d84fc7d883b14e0f88b9ab83ff28a162a8d10ccfa4f758f940184941d531b82` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/btime/bin/darwin-x64-101/btime.node` | 44,032 | `ed5cb9d0430b9dfb5cc9754bb46c2f6023c63451d625354bcf9f2a512ff49f5b` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/btime/bin/darwin-x64-87/btime.node` | 44,024 | `bcea7514ef4c63e8f4fa7d1f5b56c88a2510792e630884d4d87fc3ae6c3d641f` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/btime/binding.node` | 160,768 | `1bd8bc980851229140442975a604e9edb7143fbe322050d0b460b7a7092cbbbd` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/btime/index.js` | 1,792 | `ebe780273f9c6f7707f2e2dfc82ec7e6de8b4ecaa5216c5c35d08e0782d7ab40` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/btime/package.json` | 299 | `4f829104aa8c37bcdfd4ca9d5c4fb3af94b0a1fd7737c0b3179fad825e293c8f` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/get-fonts/bin/darwin-x64-101/get-fonts.node` | 71,280 | `6e8e699b97e378ac1258e972cd95372151c5bc84c86be6a7393b8bb26d3d2f90` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/get-fonts/binding.node` | 201,248 | `94eceb37c3a062acbead1e7db37362aa20faaf0f6d290dc87bf0e996145883b5` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/get-fonts/fontsMac.mm` | 784 | `a6280a1aa7485c569dc155648109532fe037b7d0e2c3e64a67b55df2da3b82ed` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/get-fonts/index.js` | 122 | `8a8e8a8b6af20cd8002d4935c6c6446d3031dae97114eb3c35a1e7c282366d35` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/get-fonts/package.json` | 261 | `c6d7437226a4277d271c0a50d13349cf89ce6d2656b04a6c598a415aa7bffc00` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/common.gypi` | 797 | `d1f38562aa923e16c81512df718e49e308ff6b407ae7ed8a90637603ffe70c34` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/except.gypi` | 560 | `ddbc09f5b66fe24dd898fbe659085a6ff72e9575025004fc3762271dba781e8b` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/index.js` | 435 | `afbfa96b5c40c643828f212610129d2911095eff1e86e63ccfe81658d6fe61d9` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/LICENSE.md` | 1,150 | `89024017b88a9f2b763f79b941a4f2db3b4428edfcacdc0b23866b2da633ad0c` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/napi-inl.deprecated.h` | 6,323 | `b66ed1e565e735bbfabcc2f72d466ab7c5414d3ef8851d1af440b81be7f2375c` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/napi-inl.h` | 230,609 | `3a2e9cad48cd1d9cdd2aa52438e838a51424beadf83e2ab2243477675f8d8127` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/napi.h` | 118,405 | `a2d62b9b80bd544ed7c11a5340fb72fce906deecd013ae039d878cfe9512e757` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/node_addon_api.gyp` | 793 | `a1f080ca22f191902d118bc2a169984a9e761af091ca6d0ea456197bf7b6543c` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/node_api.gyp` | 132 | `3cd2c44fb0974f016376b676d46bbebbca7c89d4383b09ece30e4cb4122a1499` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/noexcept.gypi` | 639 | `494060b87197c489497a038504147c435b1d09306152048add42ba0d7d16e747` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/nothing.c` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/package-support.json` | 467 | `b1cb7da23cca1681c7392a3c889eb0cc4916c53d2d7692d4b654ae751f3442f3` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/package.json` | 1,006 | `02e0461c40671cd6c8684cdb11e6610f49237d1d8d96aad27762c56c283c672c` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/tools/check-napi.js` | 3,176 | `9e1207808023cd998fe9e377aefbe77d6c59fa129f94e6acbf24907149d8c11e` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/tools/clang-format.js` | 2,002 | `3e0b5e6d6f1a0c5ed106115871d0fd48f37bac5554effdacaf8d2439f4ed0c65` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/tools/conversion.js` | 15,001 | `9f375b0f9d9ec93c2ded07470478b3f523a2661c6ca707c28b0e9dae15009002` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/tools/eslint-format.js` | 2,071 | `befbda4868248093b1f5e4307d28f412d12fa16929cd0c07f5e2575e2635646d` | uninspected | [Open audit work](#open-audit-work) |
| `node_modules/node-addon-api/tools/README.md` | 3,217 | `65e9ea918538f453166b10a1d609cf44cec3d2d01f23fecb5265fb3a4bf303d5` | uninspected | [Open audit work](#open-audit-work) |
| `package.json` | 356 | `e395cb2d1b34ebd4b37b3a2472073cb785d8588d21f8ac46c83c5dff2e5c0c87` | focused | [Evidence](reference-evidence.md) — manifest metadata only |


## Installed macOS host envelope

Paths are relative to `/Applications/Obsidian.app/Contents`. This table inventories every ordinary, non-symlink file reachable in that installed Contents tree. Symlink aliases are not counted as additional code. Nested ASAR/archive/PAK/snapshot content is **not** thereby analyzed: `app.asar` is expanded in the launcher table, while the Electron default-app archive, Chromium PAK resources and V8 snapshots remain opaque. No native disassembly or runtime-library audit has occurred.

| Artifact-relative path | Bytes | SHA-256 | Status | Existing evidence / remaining scope |
| --- | ---: | --- | --- | --- |
| `CodeResources` | 2,346 | `bf8c887932394db5410e62b8d017cc4ae5b8831cc50061f8aab496e2a0680888` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Electron Framework` | 322,000,768 | `b926760eb7ad82b13c99a560995c1ce4ec035ecc51cd0e342cc6a9d070551d00` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler` | 2,229,408 | `67398805332541ec2e60e35d0b9b9f3289fb1eb0a525e6dfbc9b918e3962cff7` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib` | 508,208 | `86646f3fd5f72e9c9a334bad8765e7d0a34e1d8cb518f03d95148e5fc7625eb9` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib` | 15,363,232 | `0e8c30087c19e97074fa1d5e3411ef237ac2be314b00f7238aa69583a0f7109e` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib` | 4,555,056 | `c733159f0648f59de211bf053a6cf00db4ef904142d4c3609b8e685ab66d43ff` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib` | 21,312,688 | `4b6f36ee204008e62057965de2722b147b7c7f907953427f9bc80f0e508554b9` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Libraries/vk_swiftshader_icd.json` | 110 | `d717d915e31e7c27948b80b36ab34e2d897888114c5c7d0af835f93eb53e58f5` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist` | 1,306 | `95b00fb8127b6e39c52ee4f7318190ee1cf98318d9b33747d076003ec6a58a73` | focused | [Evidence](reference-evidence.md) — version/bundle metadata only |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/MainMenu.nib` | 2,005 | `4b2168de2d6d9a09b20faaa23139d5f25f73b2595671de25872d191b6939d819` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/af.lproj/locale.pak` | 504,970 | `40dc17a786f56572a5b4d8a54d155047dfbeb48b282a1ef6a973c0f972915bf6` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/am.lproj/locale.pak` | 818,553 | `f9fea28a9d8fe53fc96038ad9138186eaf957e1b4fd5ec4f951bd56ceeb7c9c0` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ar.lproj/locale.pak` | 893,569 | `750e69477d1c88a5d94d41be3f439d2e9dbc806ea8ebb355591beb0bd15e652d` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/bg.lproj/locale.pak` | 933,866 | `8b9cfaefffdf421d98e5a8ec0112adce3518233013ac6684d653e337ec083a68` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/bn.lproj/locale.pak` | 1,201,756 | `c0674d66fc93498890e1e20dbea19d7272d918966eaab746d6faa2f25b19ced2` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ca.lproj/locale.pak` | 567,970 | `97d1e59a86eccca30c8e23f0483e286b4d96ecfb1b3de01cd763449214cec62b` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/chrome_100_percent.pak` | 103,368 | `d04414d78884d0ffe2b02f558f8c21384dcd755bc1b02a6102ef0944fe8829f4` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/chrome_200_percent.pak` | 160,807 | `0e09f44068984ac33e80a047e835e4753b43d3d6fca40b5bd49c64f7a4882898` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/cs.lproj/locale.pak` | 584,442 | `3e58d72d91b46d2fc1e99aacd90e48a52ba2b937cea6dba2b4d988acef371b89` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/da.lproj/locale.pak` | 529,263 | `4cd0c21e97bbd27ccb4ea68beaf1f768d9c0d37e4955afe791143e2e8de8cb97` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/de.lproj/locale.pak` | 564,638 | `50b11d5595d1fd421c8659bb33a30bb48c106eaeeef56159d2bc3c8dd5446119` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/el.lproj/locale.pak` | 1,023,260 | `f77302a3d564571b851e4ddd870e070a254a19a0686d39703c5cc5470ad5a6fd` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/locale.pak` | 464,610 | `b2fc8f772dc74ef497ca3784f6db1d32ed4bbbe9c3875328ba21171d6ad0aec5` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/en_GB.lproj/locale.pak` | 460,492 | `0ae5bccedc0c2744802cbc98f6659a89a01906e76f70263d4348e885b8da9703` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/es.lproj/locale.pak` | 558,891 | `92c3125b2e110d737b8e638a07139e7b37a78348df3e7d9a483141bf8e6cea3e` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/es_419.lproj/locale.pak` | 559,534 | `9028f170aa943f31452d967d6f4dcc5acbff94e0ee6d758508db0b6cccf4e4ba` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/et.lproj/locale.pak` | 508,961 | `781283b6d2f49934df7f445a382c2260084615939e01c77913ffce7862bc6a96` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/fa.lproj/locale.pak` | 831,135 | `ea72fbe75f8ded32e83f62cd6b609efd442c95d54232f13fa59cd6cb7d3998b0` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/fi.lproj/locale.pak` | 519,326 | `62727490d4ae36721894ab341153810e986b806ec2523a792a3fa57bffd54bda` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/fil.lproj/locale.pak` | 586,684 | `e03107b99df2d8da5dbf070e6584072bc01bdd87ae3fe1e55f089f540017c219` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/fr.lproj/locale.pak` | 603,793 | `1554f76640f1718273f9712af6e951a07612b35516b29450b28f41e98afb0d21` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/gu.lproj/locale.pak` | 1,181,186 | `32657261ea189fec344dbc66037f330124647dce76554d0868c207e166ec92d1` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/he.lproj/locale.pak` | 728,311 | `d0ae686fc4ad7d2add44bd8d611b0ad0bdc35532fb47ff826b5b09ae6472a42f` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/hi.lproj/locale.pak` | 1,246,273 | `4c60e77840af17296f38b2861ee310804aeed95195f2690b647dc98ce9bc84cb` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/hr.lproj/locale.pak` | 563,437 | `2b03768a0a417d93158a61d27beb74b531cb8bba48bbe28da5d200559b4ca708` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/hu.lproj/locale.pak` | 607,927 | `2d23a7d983f60993d2759f636df5293d22a5c3136a1e6ae5ea2bba5aaaacd30a` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/icudtl.dat` | 10,468,208 | `9ae98c06cbb0ea43c5cd6b5725310c008c65e46072421a1118cb88e1de9a8b92` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/id.lproj/locale.pak` | 502,909 | `b6f31eca207cd371cccf011d91b316cae685605316074a66b7ca5598d9af8a33` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/it.lproj/locale.pak` | 551,047 | `a0c453449125601761aa763dc88da5d61f97cb8b17d640ba6d60cddd79906c5a` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ja.lproj/locale.pak` | 672,471 | `dec8ae20fb95ebaa089f2901bad344469373756b26f71f1bfa8b814be95bb363` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/kn.lproj/locale.pak` | 1,353,665 | `f9e64ce63f538e80847722ae0e7d4aab3666969a3e38bf823ad4353bfdca6f50` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ko.lproj/locale.pak` | 567,888 | `36df4ffb0f86a3087c035a717a3d3972d814c449e07e2c21491dcc353faaf5b5` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/lt.lproj/locale.pak` | 610,928 | `22b58fa11140337bca9bc9d85d016ef1d2951f25ec2e4730e999d547041c5e87` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/lv.lproj/locale.pak` | 610,133 | `02882fbf6d3b82ecd40a07af8b9e6be8d0a2e43c4ebfa2e53c9c379f3d50644d` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ml.lproj/locale.pak` | 1,409,920 | `38515c917993368cd618da5379565854d19b37b6bdb1f4ca75f8f35a8b882ac5` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/mr.lproj/locale.pak` | 1,159,109 | `a367e9956e941e37797ace37312918b8e6ab93f966ba3d29b4e08c97c9785ca1` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ms.lproj/locale.pak` | 527,144 | `e8e754134171e9aada98e4cc236f1a36c5e7e18ffd69b47b31d0768a0ca77f33` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/nb.lproj/locale.pak` | 509,390 | `e04289d950f9379275d576be2d51f8089b53f8987ceb95c0203c57022f20d93e` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/nl.lproj/locale.pak` | 527,046 | `daf5a566e487dcf9e236320f48936aafe3d39eecd755a4c05a4185481964cd32` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/pl.lproj/locale.pak` | 586,952 | `0a94b453005fc93d0f933358eaf7ccd57aea472f7905859914c220e6213d56d7` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/pt_BR.lproj/locale.pak` | 551,828 | `397940238f2fa2e75922eb51019a0729fcbf81b5ae2ed0dc04d394a5b788487a` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/pt_PT.lproj/locale.pak` | 555,900 | `aa6057b48eb22c739a6d52f100c498c96631ba86dd0525c7184843898fa58463` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/resources.pak` | 5,547,098 | `515a36252233d4454081d97101fb4edc31eeb435d55f90fb5e3cdde94ed70311` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ro.lproj/locale.pak` | 575,150 | `9d7d03637437292f43ee9c834c265f03f420f11cfa0195fa7e322cc19ae38cf4` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ru.lproj/locale.pak` | 943,504 | `a2fb0cf4d0733e0bbaaddaf1493a976f2489a807fb60567a40e918f8a57e97c5` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/sk.lproj/locale.pak` | 593,379 | `deee8035fa592802930552e93386c29fc5beb2e90cb7d6921b4ac3587367be5e` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/sl.lproj/locale.pak` | 569,009 | `de229f87ed7906c198855ad7d0b113928604a8e8ee4fef7d9fab5f4f8961d86c` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/sr.lproj/locale.pak` | 877,312 | `f41c8b732c0028115eed64a71df3b25247caa9f14d9812af9df79dd0a0ff0d7a` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/sv.lproj/locale.pak` | 512,430 | `0d5e86a6b6707b3088c2b21ba7f72b88bcb8c47ae510560205a9d39dd5653eef` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/sw.lproj/locale.pak` | 542,180 | `ba18181404255c790972c016083a12823606a646c6c91434e9247d81e58e6e43` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ta.lproj/locale.pak` | 1,402,736 | `7a1a5b82a4058ffedbab933d8e27327dcf3baac6d5780131092e20fc6fe9f283` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/te.lproj/locale.pak` | 1,292,777 | `a287d8dbb4cd33dde52df17799385d4cd263d4fcd203222d6ec62101b48ee47a` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/th.lproj/locale.pak` | 1,084,036 | `8bca1397f51ef49b6683cd0f2e07deaa8b95e81f27eeea2e457ec5f86ffb747a` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/tr.lproj/locale.pak` | 552,328 | `fecbfa8bdf43ee803d89d1ac130fbd85d49b7f830ec6dd10cda950c579639fbc` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/uk.lproj/locale.pak` | 944,617 | `12750a8f38291d8cf8b68fd6367ee03e43293c4bc3b63a3a373e7182adfb3e93` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/ur.lproj/locale.pak` | 825,385 | `4d216fd8cb87e5060ed836187f2984cb8cd87a89f61a0e4da4f5190dbe6f1610` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/v8_context_snapshot.arm64.bin` | 662,053 | `84702ebd46e7633bb9bb2a1cb32ed4275d58a9bbce686036ec4cb9a41d39bcf5` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/v8_context_snapshot.x86_64.bin` | 662,053 | `091fd5b59936b63d45b0de8e12608033ef725b45c9933f7a2f270ec64d34916d` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/vi.lproj/locale.pak` | 653,801 | `616f6e38f15d3223ae3991701facfba9bb73fcb66bde3a339546e065021fc90c` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/zh_CN.lproj/locale.pak` | 471,268 | `120c4dee9e21e3c8ad56e5784c927d91726e2d81acf92477076d971674a4e653` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/Resources/zh_TW.lproj/locale.pak` | 465,779 | `4fbf6e474974f02700f8f3eec6d5a13e74e7d1cbaf3845d12ba58a2f977c3752` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/CodeResources` | 24,787 | `630fb9096e4a4090336f6201d935786de3f9786ef7750ed487539d1201564d1f` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Mantle.framework/Versions/A/Mantle` | 223,648 | `dc930fdce73c74c08ec58c4205a07933e3a386376c1bf8bd43288df6dd924ca8` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Mantle.framework/Versions/A/Resources/Info.plist` | 1,403 | `106eb80778be73c4afd3ada7e1695bff7e9dfc0f8ce0232f59c64fe461e5872d` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Mantle.framework/Versions/A/_CodeSignature/CodeResources` | 2,442 | `810941643e6df99ad7725fe970a6b15511d022569d3509201359fa514b366a03` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (GPU).app/Contents/Info.plist` | 1,422 | `7acfbdfc8d6505226686ccc0bf00beb53afd78d79f90b0176370930873af9132` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (GPU).app/Contents/MacOS/Obsidian Helper (GPU)` | 270,352 | `ec1f5e9be6fa260dfe3e189f9a30a0b1cc09db75ef882071e4c2a52b857840bc` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (GPU).app/Contents/PkgInfo` | 8 | `82502191c9484b04d685374f9879a0066069c49b8acae7a04b01d38d07e8eca0` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (GPU).app/Contents/_CodeSignature/CodeResources` | 2,200 | `6686de10a28a2fe11b36cbb86dcbacc827cfc4ea116b4dabf1845e5aee629e9b` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (Plugin).app/Contents/Info.plist` | 1,434 | `dcf261906ee501608f80bd477ee30624f9db6b24a094993b9458db645a152b06` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (Plugin).app/Contents/MacOS/Obsidian Helper (Plugin)` | 270,368 | `7803c0831b77ba175812b253ad762f266cbba8dc391c3e251afc27510df33eab` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (Plugin).app/Contents/PkgInfo` | 8 | `82502191c9484b04d685374f9879a0066069c49b8acae7a04b01d38d07e8eca0` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (Plugin).app/Contents/_CodeSignature/CodeResources` | 2,200 | `6686de10a28a2fe11b36cbb86dcbacc827cfc4ea116b4dabf1845e5aee629e9b` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (Renderer).app/Contents/Info.plist` | 1,442 | `77baf16ab603e657c473130c9dd44ebe0484d5491769a51d186e8d5177dd62b5` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (Renderer).app/Contents/MacOS/Obsidian Helper (Renderer)` | 270,368 | `56d2fb52bb2f44f53201e3ee4b1158b8311b9701f1011f2c621d1fcdd0eb6402` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (Renderer).app/Contents/PkgInfo` | 8 | `82502191c9484b04d685374f9879a0066069c49b8acae7a04b01d38d07e8eca0` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper (Renderer).app/Contents/_CodeSignature/CodeResources` | 2,200 | `6686de10a28a2fe11b36cbb86dcbacc827cfc4ea116b4dabf1845e5aee629e9b` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper.app/Contents/Info.plist` | 1,400 | `b25587234895044fd2f5a0ad77ce005d8e6f86a49aa10690d4a247a334387982` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper.app/Contents/MacOS/Obsidian Helper` | 270,352 | `de4759db06f7828ec03dced152e2e1708b18b6d3a96e62cc9c22041980c07603` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper.app/Contents/PkgInfo` | 8 | `82502191c9484b04d685374f9879a0066069c49b8acae7a04b01d38d07e8eca0` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Obsidian Helper.app/Contents/_CodeSignature/CodeResources` | 2,200 | `6686de10a28a2fe11b36cbb86dcbacc827cfc4ea116b4dabf1845e5aee629e9b` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/ReactiveObjC.framework/Versions/A/ReactiveObjC` | 802,096 | `570a5fe7a94567053b21c76be643844fdacbede6e6bd2874d5f1a9d2562cc263` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/ReactiveObjC.framework/Versions/A/Resources/Info.plist` | 1,529 | `0ed0b328b69c4251e2ba085094e25d6c28ca7abc9311adb12b24902a4e60f6a7` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/ReactiveObjC.framework/Versions/A/_CodeSignature/CodeResources` | 2,442 | `ea3fcbda3538f5b51993a48e0388690abf929d032dfffb006dcd4cccb5fde964` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Squirrel.framework/Versions/A/Resources/Info.plist` | 1,564 | `1f2a83139468ef080563072f776233b80bae839344954ad1716e6dd62f96ae05` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt` | 293,664 | `023ce2ebb928853eb315abb1707f047dfef30d7831a12b6b5189f3044f8e742a` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Squirrel.framework/Versions/A/Squirrel` | 312,336 | `67762fd76461a334941bcc2a6c46cb31fa37596fdda40dd45b8d2a1ed35994aa` | uninspected | [Open audit work](#open-audit-work) |
| `Frameworks/Squirrel.framework/Versions/A/_CodeSignature/CodeResources` | 2,660 | `4ac67f8ca835f0bcbb0719568527a0098e4b1fc6dd2b6406ae4345388defb575` | uninspected | [Open audit work](#open-audit-work) |
| `Info.plist` | 5,399 | `cf59d49b65d4501b7aa302ee2072100cc9f761a3762895d2e8248dfa3185f7f9` | focused | [Evidence](reference-evidence.md) — version/bundle metadata only |
| `MacOS/Obsidian` | 135,296 | `601a8a4518e5a7627c2c7adad02683db614bad6407df8332bc2f31fa74e46083` | uninspected | [Open audit work](#open-audit-work) |
| `PkgInfo` | 8 | `82502191c9484b04d685374f9879a0066069c49b8acae7a04b01d38d07e8eca0` | uninspected | [Open audit work](#open-audit-work) |
| `Resources/app.asar` | 628,423 | `0a31162efe161023def5390fb00ef75e21cd9dc1cc71bda328508e2e8f2f8dc1` | partial | Expanded member inventory above; behavior not audited |
| `Resources/app.asar.unpacked/node_modules/btime/binding.node` | 160,768 | `1bd8bc980851229140442975a604e9edb7143fbe322050d0b460b7a7092cbbbd` | uninspected | [Open audit work](#open-audit-work) |
| `Resources/app.asar.unpacked/node_modules/get-fonts/binding.node` | 201,248 | `94eceb37c3a062acbead1e7db37362aa20faaf0f6d290dc87bf0e996145883b5` | uninspected | [Open audit work](#open-audit-work) |
| `Resources/icon.icns` | 705,331 | `313153fc79bbf31b3c7e4639cf71552441f2e7de449e2965267eebaf58f326b5` | uninspected | [Open audit work](#open-audit-work) |
| `Resources/obsidian.asar` | 23,008,038 | `454462e6316bb9ea9726403e887a8be691eb34b2cff70a0a8d6db4d3de7615d9` | uninspected | [Open audit work](#open-audit-work) |
| `_CodeSignature/CodeResources` | 6,922 | `fcf7e75887500ce6284a6cd739b563a864d5201f4978f8988e698434f7ceaa25` | uninspected | [Open audit work](#open-audit-work) |

Outer installed host files inventoried: 107. This identity pass does not establish signature validity or unpack opaque resource containers.


## Android executable and web/configuration inventory

Paths are APK member names. This table includes all `.dex`, `.so`, `.js`, `.mjs`, `.cjs`, `.wasm`, `.json`, `.css`, `.html` and `.jar` members, the manifest/resource table, and selected native XML resources whose manifest references were resolved. Resource/metadata-only readings are explicitly separate from bytecode analysis. Android styles and translations embedded in `resources.arsc` are only partially decoded, not audited.

| Artifact-relative path | Bytes | SHA-256 | Status | Existing evidence / remaining scope |
| --- | ---: | --- | --- | --- |
| `AndroidManifest.xml` | 27,376 | `7e72fe1ef8c1980a562b2a49b7236d06707a8d7840bcf448f92e2505beeaf2a6` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `META-INF/com/android/build/gradle/app-metadata.properties` | 57 | `f4db02dffd58ed7e8cc3f5d450f625d3553b00469e30b757bf9ec329552ad33e` | focused | [Android](android-reference.md) — explicit metadata/declarations only |
| `assets/capacitor.config.json` | 516 | `538f87b25f2a21514c87a26581814aa5d90a050f725b76d0357960a402b6bba7` | focused | [Android](android-reference.md) — explicit metadata/declarations only |
| `assets/capacitor.plugins.json` | 1,424 | `4e610603aa04e675ddc22f7e33ea9cd2a54d7505e485fa0f1a22149d505e7ab8` | focused | [Android](android-reference.md) — explicit metadata/declarations only |
| `assets/native-bridge.js` | 49,718 | `6e57635767369af304b217171b84812350c117d2a94b91bfefb112d03c4169f1` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `assets/public/app.css` | 662,509 | `bd60bebb15789882564e92303a6323816c38d5e15e2c7d96694e51cfb54c8f3e` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/app.js` | 3,968,611 | `b0452336e0926983c240ce168bb03bcc308d32a54fc97cdd5db72ed7f333f997` | partial | [Android](android-reference.md), [attachments](attachment-reference.md), [Bases](bases-reference.md) — bounded static readings |
| `assets/public/cordova.js` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/cordova_plugins.js` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/enhance.js` | 13,229 | `dae6559565e737174c7063a16f7214a2795330e0262577d3ecc59a1b53caebd8` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/i18n.js` | 132,996 | `61b21057ba649a09149c1c4461233f785bc8d660b3845e5b2975f1c9a5d19713` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/index.html` | 1,489 | `37417dcebc4c3d5ed419699a2e710f5e84807cf7a3e8dfc2a96b35156c24d7ed` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `assets/public/lib/codemirror/cm-addons.js` | 58,679 | `fa370184a49e72482751cbdd253ad7821ec11ce1e92da39f0a232568504334b1` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/codemirror/codemirror.js` | 400,161 | `2150c2e30dcc28427b0cacb31c8073e2f8cdbeb1b03d61214a7200809bf21a43` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `assets/public/lib/codemirror/markdown.js` | 45,052 | `b339279a0496b870dbf8dd61397610eb8c9755feb5643301cd713114f70bdc32` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/codemirror/meta.min.js` | 12,792 | `97f787318cca86f26348148ed84ed2510b190a868b86363adb24cdd78a33fcfb` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/codemirror/modes.min.js` | 562,656 | `016713740d2428f9686a173cb4614c3a611ace8a9a25db8dab4ed30e9c77a745` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/codemirror/overlay.js` | 3,099 | `4f158e3ba838c18621c62a8f42524db718f75974c6ad042bf9e9b828e35e0155` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/codemirror/vim.js` | 248,977 | `2e1c8efa02fd4e4794e91567955e9c8821a311e18bb7798923d9b8ecece73636` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/defuddle.full.js` | 750,220 | `6860b24acdc776a32d3aea78f90e5cb8cea2488b144321f0c06fc8cc8c418128` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/i18next.min.js` | 41,340 | `7980f21b960a94e89dd35cbc429be1f25eaf4a76220d96252d83b0c70301de4f` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/mathjax/obsidian-mathjax.js` | 1,139,224 | `ac00d774192009417b8fa50412f4b27f94426014e7526fe1151276a9784de965` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/mermaid.min.js` | 2,964,042 | `6ef73c979e4636b0724eb3b4ee505e53e3a117e4cae31914ec5b2d64f27ff603` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/moment.min.js` | 375,043 | `b19e17770b1673aca44065e7dc2c393d306559871b99bfe885a0d10d4f2798cf` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/pdfjs/pdf.min.mjs` | 566,729 | `f298004f6e2f4e67faab473513f322edc506295968e96b50041cb1a69ea90279` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/pdfjs/pdf.viewer.min.mjs` | 488,821 | `7060308a7ffa11ab3112458ec58f740eb90643849beeaa6d9c9ff4441e9d35af` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/pdfjs/pdf.worker.min.mjs` | 1,130,698 | `0235bc7b0c7822334edb2f82eb2ffc7954b971e4c7e57acca4703f6c2555efe4` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/pdfjs/version.json` | 65 | `0a8ac68bb7f1845ad8eb795e7147abf66f75c79b5e585c5985dbad4d42ad1eec` | focused | [Android](android-reference.md) — explicit metadata/declarations only |
| `assets/public/lib/pdfjs/wasm/openjpeg.wasm` | 257,382 | `cb031f36245b389e1f5bffc59d10eed35bb0f85d7368b46c3f0b462042ec8e9e` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/pdfjs/wasm/openjpeg_nowasm_fallback.js` | 462,316 | `53c228428a8861035a34738966af263fc9d4cee6df25a0ad942af947469a0bd9` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/pdfjs/wasm/qcms_bg.wasm` | 94,519 | `6017eca5939cde1836e88e6d8cd27ae039246f206515ea4487bdfd0e3fb16e26` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/pixi.min.js` | 487,134 | `842814b22c348dcdab381ffb79da3763ff0672271f60f09dababa52656fd31b8` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/prism.min.js` | 576,531 | `9389ca2110991b037228c190018c94abcf25d1af0ad32fc51b78263660acbddb` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/readability.js` | 32,556 | `b17dea4bd122b5f0c32b6d55801607ea1492292f14aba9d97448f1fde395a2ef` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/reveal/black.css` | 6,980 | `67439d656fa1c04ebaef2f252729b954524a55de79afb4a399749eae063b1d74` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/reveal/reveal.css` | 46,725 | `cb3c0deb593f2f6527a5955f47a3f6e2c192b2bed35fb52231c95966e2d2d727` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/reveal/reveal.js` | 89,690 | `b82b9b79b9052fb447f74c2b6f63b1d2d906b419a8a7f648d70418418bd7daf2` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/reveal/white.css` | 6,967 | `2dae508dd0677cc750605df1a62d8cf90754a5ea80f1d00f446d4f5e49af5e72` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/scrypt.js` | 17,877 | `437b12082063e4d09d2e3704a9fcb398feaef4978e9c4969bfb1d00cfd433676` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/lib/turndown.js` | 10,697 | `f552fd2818a9d3c0ad6fa9f47524c52b4966a9d9a31e68cfaf05196c6cd773f2` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/sim.js` | 17,693 | `549be2f69710af360d521c92b80c83718f673594d3dc2255a65e251199eee25d` | uninspected | [Open audit work](#open-audit-work) |
| `assets/public/worker.js` | 239,777 | `a42f7927658132927e124131fdb7fc69fdb2853097c24158e0fdb245b87c34ae` | uninspected | [Open audit work](#open-audit-work) |
| `classes.dex` | 6,857,856 | `c82c18302ab7f3e810df433a974894c68ef1049c7dad38abe4dd3ae407339855` | partial | [Android](android-reference.md) — declaration parsing only; no method body audit |
| `classes2.dex` | 212,816 | `a6cb229a91c94ecb840285e67102dc889e8b03ee5d1f732d472938f2e508702c` | partial | [Android](android-reference.md) — declaration parsing only; no method body audit |
| `kotlin-tooling-metadata.json` | 625 | `b953c358ec442d8d0d6e68778b509276cb62cd12fdbfa7c6dc563a5b3e3e709a` | uninspected | [Open audit work](#open-audit-work) |
| `lib/arm64-v8a/libandroidx.graphics.path.so` | 10,096 | `41e9a793c43a0f4fddb19e33f346bace464f30f888ba7b9eaf96294ea115bfb6` | uninspected | [Open audit work](#open-audit-work) |
| `lib/arm64-v8a/libdatastore_shared_counter.so` | 7,112 | `d3e48717c9aa147e0ab21063ba0e8e0211cabf8bf40b222640829519edbf58e1` | uninspected | [Open audit work](#open-audit-work) |
| `lib/arm64-v8a/libfs.so` | 386,752 | `adc0b3c44e7167ebf75f835e96a3445d5ddb9f7a3d0199427096c81165689ce6` | uninspected | [Open audit work](#open-audit-work) |
| `lib/armeabi-v7a/libandroidx.graphics.path.so` | 7,252 | `41399eba6fc2a60f6f14642375c1824f3cf25eb8fec7397d753730a3ceda3e2b` | uninspected | [Open audit work](#open-audit-work) |
| `lib/armeabi-v7a/libdatastore_shared_counter.so` | 4,416 | `716c5d8d2cac8ca0edf65da8f139c7886b726ac79d542a14edeb94994ba6d3dc` | uninspected | [Open audit work](#open-audit-work) |
| `lib/armeabi-v7a/libfs.so` | 240,496 | `76ee2897344215bbd81a64498490c303bb74d123ccc4cf88de361f1764386692` | uninspected | [Open audit work](#open-audit-work) |
| `lib/x86/libandroidx.graphics.path.so` | 9,284 | `eb0570b41fd3bff25d8204a967c03bd7550719e768b791f680cc40cbe35f29af` | uninspected | [Open audit work](#open-audit-work) |
| `lib/x86/libdatastore_shared_counter.so` | 5,148 | `cd4a1649e2c8350703146f94a6ee2bf4c3c8c9f172159f805b61a4a2abdf0659` | uninspected | [Open audit work](#open-audit-work) |
| `lib/x86/libfs.so` | 352,684 | `4424f9a255a38d38a1cd8ff78187812ece888fb103e9cb0d18edec7293fe9f46` | uninspected | [Open audit work](#open-audit-work) |
| `lib/x86_64/libandroidx.graphics.path.so` | 10,760 | `4e56c996f13670e70082658de7880c4020eabf4f25e43387f88ed78a713fc9f0` | uninspected | [Open audit work](#open-audit-work) |
| `lib/x86_64/libdatastore_shared_counter.so` | 6,224 | `fb6c9208988c49ae94943bc3236fa763ba584722e044fa4ea9a12d2941027105` | uninspected | [Open audit work](#open-audit-work) |
| `lib/x86_64/libfs.so` | 369,376 | `4f804d3a208677ef41e850129ceda4261ff02d50da915e578cc16d275a8eccb7` | uninspected | [Open audit work](#open-audit-work) |
| `org/apache/cordova/allowlist/index.html` | 2,109 | `5540004eb5fba60d58e9ecc4da04652841d4fac98c2a9ecae594ca5afccf080b` | uninspected | [Open audit work](#open-audit-work) |
| `org/apache/cordova/allowlist/index2.html` | 1,683 | `479c0823d6d57965d0903fa682ca4e5f8d287c4a8737dd0ff637495987e5fc57` | uninspected | [Open audit work](#open-audit-work) |
| `res/4n.xml` | 848 | `c1b081dd6e09f38b0a44790231a61dd5fad43167482de34bb5a2b0413489005e` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `res/8K.xml` | 1,044 | `47e368339bba23e8ce59d90d8ec3fd5344264200467ea4a98a5d6966094099a0` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `res/Co.xml` | 676 | `56f233cd9fa5d713411c7c1cbe0e5a8f6b4890e2f551931a38bce426d714dac2` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `res/oM.xml` | 848 | `656f58b19081cac210d13e75b73f41eedb779d8a843feba4bc0e2d0cd1540954` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `res/y0.xml` | 848 | `97e17e2d0059eba1492095685e4642fe537ef7d934b9a1d7afd01895d4b44a2f` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `res/z_.xml` | 848 | `be48d603b5267154204fa49422d6f05c48e9a7c021ff45f07285fb26d134ba23` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |
| `resources.arsc` | 887,108 | `6178b2d4be3e44350dedf745a1445fd713ef7a0446c2d4866d58cd6ed1340b1b` | partial | [Android](android-reference.md) — selected metadata/declarations/branches |

Expanded Android executable/configuration rows: 66 of 1830 APK members. All other member identities remain in the REA archive inventory; opaque, graphical, translation, layout, font, dependency metadata and resource internals require their own coverage work.


### Android native declaration coverage

The original, independent standard-library parsers recorded [manifest/declarations](/private/tmp/zorid-reference-20261016/android-native-declarations.json), [selected resource resolutions](/private/tmp/zorid-reference-20261016/android-selected-resources.json), [DEX declarations](/private/tmp/zorid-reference-20261016/android-dex-declarations.json) and [dependency metadata](/private/tmp/zorid-reference-20261016/android-library-metadata.json). These are not REA/JADX findings. The resource parser did not decode every layout, locale, style or resource variant.

| Scope | What is actually covered | What remains open |
| --- | --- | --- |
| `classes.dex` | 10,425 class-definition identities counted; selected named classes, method declarations and runtime annotations decoded | All method-body semantics, call graphs, reflection, native calls, initialization and dynamic registration behavior |
| `classes2.dex` | 315 class-definition identities counted; selected Obsidian quick-action/widget/tile declarations decoded | All bytecode bodies, lifecycle behavior and interactions |
| Native plugin registration | 13 `capacitor.plugins.json` package/class entries; matching selected class annotations; built-in Capacitor bridge class annotations also observed | Exact dependency versions/forks, registration order, argument/result/error contracts, permissions and runtime invocation |
| Keyboard extension | `KeyboardPlugin.isMultiWindowMode` and `hasPhysicalKeyboard` declarations; `isMultiWindowMode` code offset 2478352 in `classes.dex` | Those method bodies and actual events/results; declaration presence does not prove stock plugin compatibility |
| Manifest and intents | Package/version/SDK/permissions; main/share/URI intents; five widgets and five quick-settings tile services; FileProvider configuration | Effective OS grants, URI/path enforcement, exported component behavior, share handling, setup/persistence and background lifecycle |
| Native ELF | 12 `.so` members across four ABIs, byte identities listed above | No function, symbol, syscall, filesystem, JNI or ABI behavior analysis; notably `libfs.so` is not covered by the JS Filesystem interface |
| Dependency metadata | Packaged AGP/AndroidX/Compose/Glance and other version records read | Exact Capacitor version remains unknown; no broad package equivalence inferred from neighboring dependency versions |

No APK installation, execution, decompilation, device trace or performance measurement occurred in these passes. The missing JADX provider limits REA native code analysis; it does not erase the remaining audit scope.

## Artifact-to-behavior report map

| Existing report | Source artifact and covered questions | Remaining boundary |
| --- | --- | --- |
| [Reference evidence](reference-evidence.md) | Desktop `main.js` AST observations; `app.js` YAML/properties/embeds; package/host identities | Main IPC contracts, initialization, complete module/plugin/API mapping and all runtime validation |
| [Editor reference](editor-reference.md) | Selected desktop `app.js` editor construction, reveal rules, table cells, selection/source mapping, undo propagation | Complete editor extensions, all commands/keymaps, composition/IME, selection, drop/paste, search and measured behavior |
| [Attachment reference](attachment-reference.md) | Selected desktop/Android `app.js` images, lightbox, dimensions, destination/name handling; PDF version metadata | Full PDF.js integration, file types, media, ingestion pipelines and all external/native paths |
| [Bases reference](bases-reference.md) | Selected desktop/Android `app.js` view registrations, schema, filters and extension hooks | Complete expression engine, table/cards/map/calendar behavior, persistence and plugin compatibility |
| [Android reference](android-reference.md) | APK selected web metadata/mobile branches plus independent native declarations | All native bodies, bridge runtime, app-local versus arbitrary-vault storage, widgets/tiles, keyboard/layout and OS integration |
| [Interaction parity](interaction-parity.md) | Required comparison protocol | A test plan is not source coverage or a completed comparison |
| [Desktop validation](desktop-validation.md) | Zorid native smoke tests and observed defects | It did not execute or compare Obsidian, and cannot establish reference behavior |
| [Parity ledger](parity.md) | Implementation progress and explicit gaps | Implementation/test existence is not proof that the corresponding reference code was audited |

Reports capture bounded observations. They must gain precise source ranges, conditions, side effects, failure cases, original implementation links, and independently meaningful tests before a behavior can be treated as closed. New reports must link their exact artifact digest and avoid converting static candidate behavior into a runtime claim.

## Open audit work

1. **Module and function inventory:** E3 identified 195 renderer bundle factories, but there is no complete per-factory behavior ledger, export/import contract map, named function/method inventory, or call-site coverage matrix. The memory-limited expanded graph is incomplete. The Android renderer, other bundles and lazy libraries have no equivalent complete retained map. Enumerate factories/functions against digest-bound source ranges and mark each separately; an entire multi-megabyte bundle cannot be checked off after a few keyword readings.
2. **All entry points and load paths:** trace desktop launcher and payload startup, starter/help/quicklook, workers and simulation, frame/iframe boundaries, dynamic script injection, lazy imports, remote bridge, native addons, updates, crash recovery and vault lifecycle. The table deliberately includes libraries even when their load path has not yet been proved.
3. **Third-party integrations:** audit how CodeMirror 5 and modular CodeMirror/Lezer are bound, editor extension ordering, Mermaid, MathJax and its font resources, PDF.js renderer/viewer/worker/WASM/fallback, Pixi graph/simulation, Prism languages, Reveal slides, i18next/translations, Moment, scrypt, Turndown, Readability and Defuddle. A version/header or matched package name does not cover integrations or forks. PDF/frame isolation and lazy assets cannot be replaced by assuming a generic browser iframe is equivalent.
4. **Native implementation:** analyze all selected desktop executable/framework/addon and Android DEX/ELF bodies, JNI/bridge registrations, permissions, storage access, share intents, widgets/tiles, keyboard/window handling, background work and error paths. Opaque Chromium packs and V8 snapshots need explicit provenance/scope treatment rather than implicit exclusion. iOS and other OS artifacts are still absent.
5. **Properties and every built-in/plugin surface:** complete APIs, event ordering, workspace lifecycle, search/indexing, links/backlinks, Canvas, graph, Bases, bookmarks, templates, daily notes, recovery, sync/publishing interfaces and settings. Existing focused findings do not establish completeness of registrations, commands, view types or user flows.
6. **Reference execution and fixtures:** static analysis cannot settle actual UI geometry, focus/cursor/selection, timing, defaults under state, OS prompts or performance. Obtain controlled fresh-install reference observations and compare the original implementation with equivalent fixtures. Native/source inspection and original implementation tests have distinct evidentiary roles.
7. **Closure accounting:** each behavior needs a source-evidence row, implementation location, verification covering its actual contract, and explicit unresolved cases. No source-file, module, function, branch, feature or parity completion percentage can currently be supported. This snapshot establishes what is present and where investigation has actually reached; exhaustive investigation remains unfinished.
