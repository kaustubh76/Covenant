import { ChainMismatchError, HttpRequestError, InsufficientFundsError, InvalidInputRpcError, RpcRequestError, TimeoutError, UserRejectedRequestError, WaitForTransactionReceiptTimeoutError } from "viem";
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

  it("passes on the Playground backend's own words when a chain may grow no further", () => {
    // uhi-11-08's backend answers -32000, which viem files as InvalidInputRpcError with a generic short message
    const said = "This Playground chain is 3000 blocks past its seed, as far as one chain may go. Reset it to start again: the Reset button in the bar at the top of the page.";
    const e = new InvalidInputRpcError(new RpcRequestError({ body: {}, error: { code: -32000, message: said }, url: "https://covenant-backend-tozj.onrender.com/v1/playground/x" }));
    const d = classify(new Error("Execution failed", { cause: e }));
    expect(d?.name).toBe("NotSent");
    expect(d?.reason).toBe(said);
  });

  it("finds the cause inside viem's wrapping", () => {
    expect(classify(new Error("Execution failed", { cause: new UserRejectedRequestError(new Error("no")) }))?.name).toBe("Rejected");
  });

  it("leaves reverts and unknown errors alone", () => {
    expect(classify(new RpcRequestError({ body: {}, error: { code: 3, message: "execution reverted" }, url: "http://127.0.0.1:8545" }))).toBeNull();
    expect(classify(new Error("something else"))).toBeNull();
  });
});
