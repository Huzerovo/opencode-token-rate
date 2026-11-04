import { Rpc } from "@opencode/plugin/rpc"

export const TokenRateRpc = Rpc.define({
  id: "token-rate",
  methods: {
    summary: {
      input: {
        type: "object",
        properties: {
          hours: { type: "number" },
          bucketMinutes: { type: "number" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    averages: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sessions: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                recent30: { type: "number" },
                session: { type: "number" },
                windows: {
                  type: "object",
                  properties: {
                    "1m": { type: "number" },
                    "10m": { type: "number" },
                    "30m": { type: "number" },
                    "1h": { type: "number" },
                    "1d": { type: "number" },
                  },
                  required: ["1m", "10m", "30m", "1h", "1d"],
                  additionalProperties: false,
                },
                models: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      model: { type: "string" },
                      tokens: { type: "number" },
                      steps: { type: "number" },
                    },
                    required: ["model", "tokens", "steps"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["recent30", "session", "windows", "models"],
              additionalProperties: false,
            },
          },
          global: {
            type: "object",
            properties: {
              recent30: { type: "number" },
              all: { type: "number" },
            },
            required: ["recent30", "all"],
            additionalProperties: false,
          },
        },
        required: ["sessions", "global"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
