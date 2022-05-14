import assert from "assert";
import { Parameters, Aggregator, DAPClient, Role } from "dap/client";
import { HpkeConfig } from "dap/hpkeConfig";
import { Prio3Aes128Sum } from "prio3";
import { RequestInit, RequestInfo, Response, Request } from "undici";
import * as hpke from "hpke";
import { TaskId } from "dap/taskId";

interface Fetchy {
  (input: RequestInfo, init?: RequestInit | undefined): Promise<Response>;
  calls: [RequestInfo, RequestInit | undefined][];
}

function mockFetch(mocks: {
  [url: string]: {
    body?: Buffer | Uint8Array | number[] | string;
    contentType?: string;
    status?: number;
  };
}): Fetchy {
  function fakeFetch(
    input: RequestInfo,
    init?: RequestInit | undefined
  ): Promise<Response> {
    fakeFetch.calls.push([input, init]);
    const response = mocks[input.toString()] || {
      status: 404,
    };
    return Promise.resolve(
      new Response(Buffer.from(response.body || ""), {
        status: response.status || 200,
        headers: { "Content-Type": response.contentType || "text/plain" },
      })
    );
  }

  fakeFetch.calls = [] as [RequestInfo, RequestInit | undefined][];
  return fakeFetch;
}

function buildHpkeConfig(): HpkeConfig {
  return new HpkeConfig(
    1,
    hpke.Kem.DhP256HkdfSha256,
    hpke.Kdf.Sha256,
    hpke.Aead.AesGcm128,
    Buffer.from(new hpke.Keypair(hpke.Kem.DhP256HkdfSha256).public_key)
  );
}

function buildAggregator(
  id: string,
  role: Role,
  withHpkeConfig = false
): Aggregator {
  return {
    role,
    url: new URL(`https://${id}.example.com`),
    ...(withHpkeConfig && { hpkeConfig: buildHpkeConfig() }),
  };
}

function buildParams(withHpkeConfig = false): Parameters<number, null> {
  return {
    vdaf: new Prio3Aes128Sum(3, 16),
    aggregators: [
      buildAggregator("a", Role.Leader, withHpkeConfig),
      buildAggregator("b", Role.Helper, withHpkeConfig),
    ],
    minimumBatchSize: 1,
    taskId: TaskId.random(),
  };
}
describe("DAP", () => {
  describe("HpkeConfig", () => {
    it("encodes as expected", () => {
      const config = new HpkeConfig(
        255,
        hpke.Kem.DhP256HkdfSha256,
        hpke.Kdf.Sha256,
        hpke.Aead.AesGcm128,
        Buffer.from("public key")
      );

      assert.deepEqual(
        [...config.encode()],
        [
          255, //id
          ...[0, 16],
          ...[0, 1],
          ...[0, 1],
          ...[0, 10], //length of "public key"
          ...Buffer.from("public key", "ascii"),
        ]
      );
    });

    it("decodes as expected", () => {
      const config = HpkeConfig.parse(
        Buffer.from([
          255, //id
          ...[0, 1],
          ...[0, 2],
          ...[0, 3],
          ...[0, 10], //length of "public key"
          ...Buffer.from("public key", "ascii"),
        ])
      );

      assert.equal(config.publicKey.toString("ascii"), "public key");
      assert.equal(config.id, 255);
      assert.equal(config.kemId, 1);
      assert.equal(config.kdfId, 2);
      assert.equal(config.aeadId, 3);
    });

    it("throws useful errors when it cannot decode");
    it("throws useful errors when it cannot decode");
    it("cannot be built from an id greater than a u8");
  });

  describe("fetching key configuration", () => {
    it("can succeed", async () => {
      const params = buildParams();
      const [hpkeConfig1, hpkeConfig2] = [buildHpkeConfig(), buildHpkeConfig()];
      const taskId = params.taskId.buffer.toString("base64url");
      const fetch = mockFetch({
        [`https://a.example.com/hpke_config?task_id=${taskId}`]: {
          body: hpkeConfig1.encode(),
          contentType: "message/dap-hpke-config",
        },

        [`https://b.example.com/hpke_config?task_id=${taskId}`]: {
          body: hpkeConfig2.encode(),
          contentType: "message/dap-hpke-config",
        },
      });

      const client = new DAPClient(params, fetch);
      const [a, b] = await client.fetchKeyConfiguration();
      assert.equal(fetch.calls.length, 2);
      assert.deepEqual(fetch.calls[1][1], {
        headers: { Accept: "message/dap-hpke-config" },
      });
      assert.deepEqual(a, hpkeConfig1);
      assert.deepEqual(b, hpkeConfig2);
      assert.deepEqual(client.aggregators[0].hpkeConfig, hpkeConfig1);
      assert.deepEqual(client.aggregators[1].hpkeConfig, hpkeConfig2);
    });

    it("throws an error if the status is not 200", async () => {
      const params = buildParams();
      const taskId = params.taskId.buffer.toString("base64url");

      const fetch = mockFetch({
        [`https://a.example.com/hpke_config?task_id=${taskId}`]: {
          status: 418,
        },
        [`https://b.example.com/hpke_config?task_id=${taskId}`]: {
          status: 500,
        },
      });

      const client = new DAPClient(params, fetch);

      await assert.rejects(client.fetchKeyConfiguration(), (error: Error) => {
        assert.match(error.message, /418/);
        return true;
      });

      assert.equal(fetch.calls.length, 2);
    });

    xit("throws an error if the content type is not correct", async () => {
      const params = buildParams();
      const taskId = params.taskId.buffer.toString("base64url");
      const fetch = mockFetch({
        [`https://a.example.com/hpke_config?task_id=${taskId}`]: {
          contentType: "application/text",
        },
        [`https://b.example.com/hpke_config?task_id=${taskId}`]: {
          contentType: "application/text",
        },
      });
      const client = new DAPClient(params, fetch);

      await assert.rejects(client.fetchKeyConfiguration(), (error: Error) => {
        assert.match(error.message, /message\/dap-hpke-config/);
        return true;
      });

      assert.equal(fetch.calls.length, 2);
    });
  });

  describe("generating reports", () => {
    it("can succeed", async () => {
      const client = new DAPClient(buildParams(true));
      const report = await client.generateReport(21, null);
      assert.equal(report.encryptedInputShares.length, 2);
    });
    it("fails if there is an hpke error");
    it("fails if the HpkeConfig cannot be converted to a hpke.Config");
  });

  describe("sending reports", () => {
    it("can succeed", async () => {
      const fetch = mockFetch({ "https://a.example.com/upload": {} });
      const client = new DAPClient(buildParams(true), fetch);
      const report = await client.generateReport(100, null);
      await client.sendReport(report);
      assert.equal(fetch.calls.length, 1);
      const [[url, args]] = fetch.calls;
      const request = new Request(url, args);
      assert.equal(request.url, "https://a.example.com/upload");
      assert(!!args);
      assert.deepEqual(args.body, report.encode());
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("Content-Type"), "message/dap-report");
    });

    it("throws an error on failure", async () => {
      const fetch = mockFetch({});
      const client = new DAPClient(buildParams(true), fetch);
      const report = await client.generateReport(100, null);
      await assert.rejects(client.sendReport(report));
      assert.equal(fetch.calls.length, 1);
    });
  });
});
