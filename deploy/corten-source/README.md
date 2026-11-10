The default `corten-source` build context of the production image: no repository, so the image
builds Corten from GitHub. Set `CORTEN_SOURCE` to a git repository that holds the commit
`Cargo.lock` pins to build from it instead (see `Dockerfile`, the `web-build` stage).
