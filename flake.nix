{
  description = "A Nix flake for the outline editor TUI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          editor = pkgs.stdenvNoCC.mkDerivation {
            pname = "outline-editor";
            version = "0.2.0";
            src = ./.;

            nativeBuildInputs = [ pkgs.typescript ];

            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              mkdir -p compiled
              ${pkgs.typescript}/bin/tsc outline-editor.ts \
                --outDir compiled \
                --target ES2022 \
                --module commonjs \
                --noCheck
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p $out/bin $out/lib
              cp compiled/outline-editor.js $out/lib/outline-editor.js

              cat > $out/bin/outline-editor <<EOF
              #!${pkgs.runtimeShell}
              exec ${pkgs.nodejs}/bin/node $out/lib/outline-editor.js "\$@"
              EOF
              chmod +x $out/bin/outline-editor
              ln -s outline-editor $out/bin/outline
              runHook postInstall
            '';

            meta = {
              description = "Interactive direct-manipulation terminal outline editor for Markdown slides";
              mainProgram = "outline-editor";
            };
          };
        in
        {
          default = editor;
          outline-editor = editor;
        });

      apps = forEachSystem (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/outline-editor";
        };
      });
    };
}
