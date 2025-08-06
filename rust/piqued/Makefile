ARCHITECTURES := x86_64 aarch64
OS := unknown-linux-gnu apple-darwin

all := $(foreach arch,$(ARCHITECTURES), \
		$(foreach os,$(OS), \
			$(arch)-$(os) \
		) \
	)

.PHONY: $(all)

$(foreach arch,$(ARCHITECTURES),$(arch)-apple-darwin):
	cross build --target $@ --release
	cp target/$@/release/piqued builds/piqued.$@
	cp target/$@/release/piqued_lsp builds/piqued_lsp.$@

$(foreach arch,$(ARCHITECTURES),$(arch)-unknown-linux-gnu):
	DOCKER_DEFAULT_PLATFORM=linux/amd64 cross build --target $@ --release
	cp target/$@/release/piqued builds/piqued.$@
	cp target/$@/release/piqued_lsp builds/piqued_lsp.$@

clean:
	rm -rf builds/piqued.*
	rm -rf builds/piqued_lsp.*

local: x86_64-apple-darwin aarch64-apple-darwin

all: $(all)