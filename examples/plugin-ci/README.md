# Example plugin repository

A complete Premation native plugin (`src/invert.cpp`) with a CI workflow that
builds it on Windows, macOS and Linux, merges the builds into one bundle,
packs a signed `.pplugin` and publishes it to the Premation plugin store on a
tag. Copy this folder to start a plugin. See `docs/PLUGIN_SDK.md` (the API)
and `docs/PLUGIN_STORE.md` (packages, signing, the store).

Locally:

```sh
# the SDK: a Premation release's premation-sdk-<platform>.zip, unzipped to ./sdk
cmake -B build -DCMAKE_PREFIX_PATH="$PWD/sdk" && cmake --build build --config Release
./sdk/bin/premation-plugins --plugins build/plugins list
node sdk/share/premation-sdk/sign-plugin.mjs keygen          # once; back up plugin-key.json
node sdk/share/premation-sdk/pack-plugin.mjs build/plugins/invert --only-present --key plugin-key.json
```

To try it in the editor without the store, copy `build/plugins/invert` into
`<userData>/native-plugins/` and use Effects ▸ Rescan Plugins.
