# [1.1.0](https://github.com/pengzhanbo/star-history-action/compare/v1.0.3...v1.1.0) (2026-09-06)

### Bug Fixes

- correct homepage, bugs and repository URLs to star-history-action ([ca80806](https://github.com/pengzhanbo/star-history-action/commit/ca808067b22ed70da86913ea192882058aafd983))
- rasterize PNG via resvg so the xkcd font renders correctly ([2d41d05](https://github.com/pengzhanbo/star-history-action/commit/2d41d0558a0f657f66dd7b3e281d347c9688c654))
- show full star counts below 1000 in the end-value label ([90c0a8a](https://github.com/pengzhanbo/star-history-action/commit/90c0a8a05fdedbdafb4d3548474db738af632512))

### Features

- cache action node_modules with actions/cache ([f87dd9c](https://github.com/pengzhanbo/star-history-action/commit/f87dd9c285003d95a8f209e70f987299e02a4ad1))
- retry GitHub API requests with backoff and rate-limit handling ([a56a032](https://github.com/pengzhanbo/star-history-action/commit/a56a032fdc01877d76d2c1cd64449d8e91d2caf6))
- subset radar font and render radar per theme ([bd63011](https://github.com/pengzhanbo/star-history-action/commit/bd63011b62f2a22c07be4483394ea983de41e683))
- support multi-repo comparison charts ([7938d14](https://github.com/pengzhanbo/star-history-action/commit/7938d143797e200ca3e74be44a0c63ced2399bb2))
- support PNG raster output via output-format input ([b7814b9](https://github.com/pengzhanbo/star-history-action/commit/b7814b97fc1b518d99cf5fdd6e22827e7751d4f5))
- support radar chart output via radar input ([7b89d01](https://github.com/pengzhanbo/star-history-action/commit/7b89d01fe7f90b65d4e6a1982ad7cc101131e293))

### Performance Improvements

- palette-quantize PNG output for ~65% smaller files ([9ec62a9](https://github.com/pengzhanbo/star-history-action/commit/9ec62a9a77a085e98f0b21da4ddd07418c67fb9a))

## [1.0.3](https://github.com/pengzhanbo/repo-star-history/compare/v1.0.2...v1.0.3) (2026-09-05)

## [1.0.2](https://github.com/pengzhanbo/repo-star-history/compare/v1.0.1...v1.0.2) (2026-09-05)

### Bug Fixes

- skip lifecycle scripts in the action install step ([f31301b](https://github.com/pengzhanbo/repo-star-history/commit/f31301bcfa449c3c6a76ee3f5a0c0f75eacbdb34))

### Features

- label the current star count at the newest point ([53bd7bf](https://github.com/pengzhanbo/repo-star-history/commit/53bd7bf39a178bac339e18558338635e4289fec5))

## [1.0.1](https://github.com/pengzhanbo/repo-star-history/compare/v1.0.0...v1.0.1) (2026-09-05)

# 1.0.0 (2026-09-05)

### Bug Fixes

- fix chart content overflow ([65e1052](https://github.com/pengzhanbo/repo-star-history/commit/65e10524c2984245d535d80671f1ca67fc85ef26))
- fix repo logo rendering incorrectly ([6621255](https://github.com/pengzhanbo/repo-star-history/commit/66212554fa045762d97e5545e3fa8be0d0218e4e))
- fix title and logo overlap ([6471359](https://github.com/pengzhanbo/repo-star-history/commit/64713598dedf5507094d2d7a6bc0c38f9dc8b487))
- harden sampling, dedupe page-1 fetch, and localize chart margins ([619d12d](https://github.com/pengzhanbo/repo-star-history/commit/619d12db6a8f3feb7b8f0cc481be167fb7a9f2ac))
- skip write-back on pull_request, pin Node 24, and require GITHUB_WORKSPACE ([4be90ab](https://github.com/pengzhanbo/repo-star-history/commit/4be90abee4ca5feecf2e7fdfdbc92aa1fe90eddf))

### Features

- add branding to action.yaml ([eb025f5](https://github.com/pengzhanbo/repo-star-history/commit/eb025f5d12cc7896df12a7539e9fb3c02b9d834a))
- drop watermark ([9ba7009](https://github.com/pengzhanbo/repo-star-history/commit/9ba7009be8a1f90aceca214653df4ef0f7b5a0c1))
- init star-history-action ([1e951f1](https://github.com/pengzhanbo/repo-star-history/commit/1e951f1e857ccd473a9a5c770c6131c637c5159b))
- load the xkcd font from assets at render time ([c079c95](https://github.com/pengzhanbo/repo-star-history/commit/c079c95372c80c5939759eb305400b0212094057))
- migrate `imagemin` to `sharp` ([9533123](https://github.com/pengzhanbo/repo-star-history/commit/9533123b38557681e9c8bd67e7fdca609fd6976b))
- optimize logo size ([32600a5](https://github.com/pengzhanbo/repo-star-history/commit/32600a5f16e189e665df53425980d0cacbacf739))
- optimize svg content ([f16e619](https://github.com/pengzhanbo/repo-star-history/commit/f16e619d865cbcb4056c24f811ce0cf01d782c64))
- optimize svg size ([4b87b20](https://github.com/pengzhanbo/repo-star-history/commit/4b87b2019eee86f0de4068fa51f9c0bbe5084911))
- remove browser support ([6c91f81](https://github.com/pengzhanbo/repo-star-history/commit/6c91f8108db75091fd66221e8f1f5c70850b92e9))
