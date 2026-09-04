import config from '@pengzhanbo/oxc-config/oxlint'

export default config({
  regexp: true,
  node: ['src/**/*.ts'],
  ignores: ['dist'],
})
