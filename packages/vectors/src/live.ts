// Real mainnet block fixtures (captured from the live node) — a permanent regression that
// codec headerHash/powOk/merkleRoot reproduce without needing a live node. Regenerate via
// scripts/gen-live-vectors (fetch /block/height/:h).

export interface LiveBlock { height: number; hash: string; header: { version: number; prev: string; merkle: string; time: number; bits: number; nonce: number }; txids: string[]; }

export const LIVE_BLOCKS: LiveBlock[] = [
  {
    "height": 21043,
    "hash": "0x000000000034c28141fa8e54202469db7a4ecfbdc0f3282f0794774a29882751",
    "header": {
      "version": 1,
      "prev": "0x00000000005b1fb22afe35b66c5a4adce7210001aa59ea333d681d6c59a25be2",
      "merkle": "0x3f1159f3f24e8a5211b5de3aeccf7cea373f6d2c8986b6ab526fead8f949fc8c",
      "time": 1780062711,
      "bits": 459735755,
      "nonce": 3380216304
    },
    "txids": [
      "0x54e2385b86a9f0cb48056db10df474cd706a7cfd51b2c668bfa61f4bdcd05544",
      "0x3ab04658b4501afb45273223af598def428bb4d372d3e2a6488b1b7e8ce1f9b9"
    ]
  },
  {
    "height": 25482,
    "hash": "0x00000000000a8da9023f56b9003ad623233b1110e6d9e0fb22adb0c9950f629f",
    "header": {
      "version": 1,
      "prev": "0x00000000000d3d402c1c57d8ddf03da2565bc0b252972b92eec4c0137941b609",
      "merkle": "0x7555f54f5d9eb97c70c7eb9a24e2f92a2b5784bc6e6a9ee099c85a0aaaa8a928",
      "time": 1780594593,
      "bits": 454356570,
      "nonce": 339526086
    },
    "txids": [
      "0x1e318b96f0de510e77f5f07f57d3621e4b0bef1fd1327f3c628d1be7a3dda667",
      "0x0741c4c7815eb0545d2e68437a38b7bb7e435c16fb301b50ccb662923fb7c2a7"
    ]
  }
];
