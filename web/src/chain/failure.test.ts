import { ChainMismatchError, HttpRequestError, InsufficientFundsError, RpcRequestError, TimeoutError, UserRejectedRequestError, WaitForTransactionReceiptTimeoutError } from "viem";
import { base, baseSepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import { classify } from "./failure";

describe("classify", () => {
  it("names what is not the contract's refusal", () => {
    expect(classify(new UserRejectedRequestError(new Error("User rejected the request.")))?.name).toBe("Rejected");
    expect(classify({ code: 4001, message: "MetaMask Tx Signature: User denied transaction signature." })?.name).toBe("Rejected");
    expect(classify(new ChainMismatchError({ chain: baseSepolia, currentChainId: base.id }))?.name).toBe("WrongChain");
    expect(classify(new InsufficientFundsError())?.name).toBe("Funds");
    expect(classify({ code: -32002, message: "Request of type 'eth_requestAccounts' already pending for origin" })?.name).toBe("WalletBusy");
    expect(classify(new WaitForTransactionReceiptTimeoutError({ hash: `0x${"11".repeat(32)}` }))?.name).toBe("Pending");
    expect(classify(new HttpRequestError({ url: "https://sepolia.base.org", status: 503 }))?.name).toBe("NoAnswer");
    expect(classify(new TimeoutError({ body: {}, url: "https://sepolia.base.org" }))?.name).toBe("NoAnswer");
    expect(classify(new RpcRequestError({ body: {}, error: { code: -32007, message: "request limit reached" }, url: "https://sepolia.base.org" }))?.name).toBe("NoAnswer");
  });

  it("finds the cause inside viem's wrapping", () => {
    expect(classify(new Error("Execution failed", { cause: new UserRejectedRequestError(new Error("no")) }))?.name).toBe("Rejected");
  });

  it("leaves reverts and unknown errors alone", () => {
    expect(classify(new RpcRequestError({ body: {}, error: { code: 3, message: "execution reverted" }, url: "http://127.0.0.1:8545" }))).toBeNull();
    expect(classify(new Error("something else"))).toBeNull();
  });
});
