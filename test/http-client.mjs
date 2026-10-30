import { request } from "node:http";

// http.request deliberately preserves Host so tests exercise a TLS proxy's headers.
export function requestJSON(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          });
        } catch (error) {
          reject(error);
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(3000, () =>
      req.destroy(new Error("HTTP request timed out")),
    );
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
