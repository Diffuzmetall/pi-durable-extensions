import { type Extension } from "@earendil-works/pi-durable";
export type DcgGuardOptions = {
    readonly binaryPath: string;
    readonly evaluatorEnv: Readonly<Record<string, string>>;
};
export declare function createDcgGuard(options: DcgGuardOptions): Extension;
