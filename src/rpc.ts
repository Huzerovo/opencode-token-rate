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
  },
  events: {},
})
