declare module "qrcode" {
  export interface ToDataUrlOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
    width?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  }

  const QRCode: {
    toDataURL(text: string, options?: ToDataUrlOptions): Promise<string>;
  };

  export default QRCode;
}
