import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("release and runtime supply-chain contracts", () => {
  it("keeps the Node 24 CI and non-root container smoke gates", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/node-version:\s*24/);
    expect(ci).toContain("npm ci");
    expect(ci).toContain("npm audit --audit-level=high");
    expect(ci).toContain("npm run typecheck");
    expect(ci).toContain("npm test");
    expect(ci).toContain("npm run build");
    expect(ci).toContain("npm run start:dry-run");
    expect(ci).toContain("docker build --tag kad-agent:ci .");
    expect(ci).toContain("Config.Healthcheck.Test");
    expect(ci).toContain("/readyz");
    expect(ci).toContain("Config.User");
    expect(ci).toContain('= "10001:10001"');
    expect(ci).toContain("--init");
    expect(ci).toContain("--tmpfs /data");
  });

  it("releases only the exact successful same-repository main CI commit", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).toMatch(/workflow_run:/);
    expect(release).toMatch(/workflows:\s*\["CI"\]/);
    expect(release).toMatch(/branches:\s*\[main\]/);
    expect(release).toContain("workflow_run.conclusion == 'success'");
    expect(release).toContain("workflow_run.name == 'CI'");
    expect(release).toContain("workflow_run.head_branch == 'main'");
    expect(release).toContain("workflow_run.repository.full_name == github.repository");
    expect(release).toContain("workflow_run.head_repository.full_name == github.repository");
    expect(release).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    expect(release).not.toMatch(/^\s*pull_request:/m);
  });

  it("publishes an immutable amd64 GHCR image and attestations with least privilege", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).toContain("IMAGE_NAME: ghcr.io/kaburajadul/kad-agent");
    expect(release).toContain("IMAGE_TAG: sha-${{ github.event.workflow_run.head_sha }}");
    expect(release).toContain("platforms: linux/amd64");
    expect(release).toContain("org.opencontainers.image.revision=${{ github.event.workflow_run.head_sha }}");
    expect(release).toContain("org.opencontainers.image.source=https://github.com/${{ github.repository }}");
    expect(release).toContain("id: build");
    expect(release).toContain("steps.build.outputs.digest");
    expect(release).not.toContain("push-by-digest=true");
    expect(release).toContain('echo "digest=$IMAGE_DIGEST" >> "$GITHUB_OUTPUT"');
    expect(release).toContain('docker pull --platform linux/amd64 "$IMAGE_REF"');
    expect(release).toContain('docker run --rm --platform linux/amd64 --init');
    expect(release).toContain('Config.Healthcheck.Test');
    expect(release).toContain('= "10001:10001"');
    expect(release).toContain("image-digest.json");
    expect(release).toContain("actions/attest-sbom@");
    expect(release).toContain("actions/attest-build-provenance@");
    expect(release).toContain("subject-digest: ${{ steps.build.outputs.digest }}");
    expect(release).toMatch(/severity:\s*HIGH,CRITICAL/);
    expect(release).toMatch(/exit-code:\s*['"]?1['"]?/);
    expect(release).toMatch(/permissions:\s*\{\}/);
    expect(release).toContain("packages: write");
    expect(release).toContain("id-token: write");
    expect(release).toContain("attestations: write");
    expect(release).not.toMatch(/contents:\s*write/);
    expect(release).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(release).not.toMatch(/workflow_dispatch|repository_dispatch|deploy/i);
  });

  it("pins every release action to a full commit SHA", () => {
    const release = read(".github/workflows/release.yml");
    for (const line of release.split("\n")) {
      if (!line.includes("uses:")) continue;
      expect(line).toMatch(/uses:\s+[^@\s]+@[0-9a-f]{40}(?:\s+#.*)?$/i);
    }
  });

  it("keeps the legacy staging writer fenced off after runtime cutover", () => {
    const sync = read(".github/workflows/sync-staging.yml");
    expect(sync).toContain("vars.KADDY_RUNTIME_PUBLICATION_ACTIVE != 'true'");
  });

  it("keeps REST publication reconciliation independent of Gateway readiness", () => {
    const bootstrap = read("src/app/runtime/bootstrap.ts");
    const publicationLoop = bootstrap.slice(
      bootstrap.indexOf("const publicationIntervalHandle"),
      bootstrap.indexOf("shutdown = createGracefulShutdown")
    );
    expect(publicationLoop).toContain("!leaseValid");
    expect(publicationLoop).not.toContain("discordRuntime.isReady()");
  });

  it("keeps the runtime image Node 24, non-root, persistent, healthy, and signal-correct", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain(
      "FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:f987682b3ea8d8e22497cb95edc5014d793612f7064e43df8104394db0ce19fe AS runtime"
    );
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("fs.mkdirSync('/data'");
    expect(dockerfile).toContain("fs.chownSync('/data', 10001, 10001)");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/readyz");
    expect(dockerfile).toContain("STOPSIGNAL SIGTERM");
    expect(dockerfile).toContain('CMD ["/nodejs/bin/node", "-e"');
    expect(dockerfile).toContain('ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]');

    const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime"));
    expect(runtime).toContain("COPY --from=dependencies --chown=10001:10001 /app/node_modules ./node_modules");
    expect(runtime).toContain("COPY --from=build --chown=10001:10001 /app/dist ./dist");
    expect(runtime).not.toMatch(/\b(?:npm|npx|corepack|apt(?:-get)?|apk|groupadd|useradd)\b/i);
    expect(runtime).not.toMatch(/\/bin\/(?:ba)?sh\b/);
    expect(runtime).not.toContain("node:24-");
  });
});
