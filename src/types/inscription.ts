import { Buff } from '@cmdcode/buff-utils'

/**
 * Class representing the details of an inscription to be minted. This class is used to encapsulate
 * the various properties of an inscription, such as its MIME type, metadata, metaprotocol, content
 * encoding, delegate, and file data. Each property is optional and can be null. The constructor
 * validates the types of the properties to ensure they are either Buff instances or null.
 *
 * @class InscriptionDetails
 *
 * @property {Buff|null} mime_type - The MIME type of the inscription content, or null if not specified.
 * @property {Buff|null} metadata - Additional metadata associated with the inscription, or null if not specified.
 * @property {Buff|null} metaprotocol - The metaprotocol information for the inscription, or null if not specified.
 * @property {Buff|null} content_encoding - The content encoding used for the inscription, or null if not specified.
 * @property {Buff|null} delegate - The delegate information for the inscription, or null if not specified.
 * @property {Buff|null} file_data - The actual file data to be inscribed, or null if not specified.
 */
export class InscriptionDetails {
  mimeType: Buff | null
  metadata: Buff | null
  metaprotocol: Buff | null
  contentEncoding: Buff | null
  delegate: Buff | null
  data: Buff | null

  /**
   * Creates an instance of InscriptionDetails.
   *
   * @param {Buff|null} mimeType - The MIME type of the inscription content, or null if not specified.
   * @param {Buff|null} metadata - Additional metadata associated with the inscription, or null if not specified.
   * @param {Buff|null} metaprotocol - The metaprotocol information for the inscription, or null if not specified.
   * @param {Buff|null} contentEncoding - The content encoding used for the inscription, or null if not specified.
   * @param {Buff|null} delegate - The delegate information for the inscription, or null if not specified.
   * @param {Buff|null} data - The actual file data to be inscribed, or null if not specified.
   * @throws {Error} Throws an error if any of the parameters are not of type Buff or null.
   * @returns {InscriptionDetails} An instance of the InscriptionDetails class.
   * @example
   *  const inscriptionDetails = new InscriptionDetails(
   *    Buff.from('text/plain'),
   *    Buff.from('{"name": "My Inscription", "description": "This is an example inscription."}'),
   *    Buff.from('my-metaprotocol'),
   *    Buff.from('utf-8'),
   *    Buff.from('delegate-info'),
   *    Buff.from('file data to be inscribed'),
   *  );
   */
  constructor(
    mimeType: Buff | null,
    metadata: Buff | null,
    metaprotocol: Buff | null,
    contentEncoding: Buff | null,
    delegate: Buff | null,
    data: Buff | null,
  ) {
    if (mimeType != null && !(mimeType instanceof Buff)) {
      throw new Error('mimeType must be of type Buff or null')
    }
    if (metadata != null && !(metadata instanceof Buff)) {
      throw new Error('metadata must be of type Buff or null')
    }
    if (metaprotocol != null && !(metaprotocol instanceof Buff)) {
      throw new Error('metaprotocol must be of type Buff or null')
    }
    if (contentEncoding != null && !(contentEncoding instanceof Buff)) {
      throw new Error('contentEncoding must be of type Buff or null')
    }
    if (delegate != null && !(delegate instanceof Buff)) {
      throw new Error('delegate must be of type Buff or null')
    }
    if (data != null && !(data instanceof Buff)) {
      throw new Error('data must be of type Buff or null')
    }

    this.mimeType = mimeType
    this.metadata = metadata
    this.metaprotocol = metaprotocol
    this.contentEncoding = contentEncoding
    this.delegate = delegate
    this.data = data
  }
}

/**
 * Helper function to create an InscriptionDetails instance for a JSON file. This function takes a Buff
 * containing JSON data and returns an InscriptionDetails instance with the appropriate MIME type, content
 * encoding, and file data set. The metadata, metaprotocol, and delegate properties are set to null.
 *
 * @param {any} jsonData - The JSON data to be inscribed.
 * @returns {InscriptionDetails} An instance of the InscriptionDetails class with the JSON data set for inscription.
 */
export function jsonInscription(jsonData: any): InscriptionDetails {
  return new InscriptionDetails(Buff.str('application/json'), null, null, null, null, Buff.str(JSON.stringify(jsonData)))
}

/**
 * Helper function to create an InscriptionDetails instance for a text file. This function takes a string
 * containing the text data and returns an InscriptionDetails instance with the appropriate MIME type, content
 * encoding, and file data set. The metadata, metaprotocol, and delegate properties are set to null.
 *
 * @param {string} text - A string containing the text data to be inscribed.
 * @returns {InscriptionDetails} An instance of the InscriptionDetails class with the text data set for inscription.
 */
export function textInscription(text: string): InscriptionDetails {
  return new InscriptionDetails(Buff.str('text/plain'), null, null, null, null, Buff.str(text))
}

/**
 * Helper function to create an InscriptionDetails instance for a delegated inscription. This function takes an inscription ID
 * and returns an InscriptionDetails instance with the delegate property set to the provided inscription ID. The MIME type, metadata,
 * metaprotocol, content encoding, and file data properties are set to null.
 *
 * @param inscriptionId - A string representing the inscription ID to delegate to.
 * @returns An instance of the InscriptionDetails class with the delegate property set.
 */
export function delegateInscription(inscriptionId: string): InscriptionDetails {
  return new InscriptionDetails(null, null, null, null, Buff.str(inscriptionId), null)
}

/**
 * Inscribe fees for a single inscription, including total fee, commit fee, reveal fee, postage, and secret.
 *
 * @interface InscribeFees
 * @property {number} totalFee - The total fee in satoshis for the inscription process, including both commit and reveal transactions.
 * @property {number} commitFee - The fee in satoshis for the commit transaction that initiates the inscription process.
 * @property {number} revealFee - The fee in satoshis for the reveal transaction that completes the inscription process.
 * @property {number} postage - The amount of postage in satoshis included in the inscription transactions, which indicates the size of the utxo that holds the inscription.
 * @property {string} secret - A secret token used during the inscription process, which may be required for certain operations related to the inscription.
 */
export interface InscribeFees {
  totalFee: number
  commitFee: number
  revealFee: number
  postage: number
  secret: string
}

/**
 * Result of an inscription minting process, including commit transaction ID, signed commit transaction hex, reveal transaction ID, signed reveal transaction hex, inscription ID, postage used, and the secret token used for minting.
 *
 * @interface InscribeResult
 * @property {string} commitTxId - The transaction ID of the commit transaction that initiated the inscription process.
 * @property {string} signedCommitTxHex - The signed transaction hex of the commit transaction, which can be used for broadcasting or record-keeping purposes.
 * @property {string} revealTxId - The transaction ID of the reveal transaction that completed the inscription process and revealed the inscription on the blockchain.
 * @property {string} signedRevealTxHex - The signed transaction hex of the reveal transaction, which can be used for broadcasting or record-keeping purposes.
 * @property {string} inscriptionId - The unique identifier of the newly minted inscription, which can be used to reference and interact with the inscription in future operations.
 * @property {number} postage - The amount of postage in satoshis that was included in the inscription transactions, which indicates the cost paid for inscribing the content on the blockchain.
 * @property {string} secret - The secret token used during the inscription process, which may be required for certain operations related to the inscription.
 */
export interface InscribeResult {
  commitTxId: string
  signedCommitTxHex: string
  revealTxId: string
  signedRevealTxHex: string
  inscriptionId: string
  postage: number
  secret: string
}

/**
 * Inscribe multiple inscriptions result, including commit transaction ID, signed commit transaction hex, reveal transaction ID, signed reveal transaction hex, an array of inscription IDs, postage used, and the secret token used for minting.
 *
 * @interface InscribeMultipleResult
 * @property {string} commitTxId - The transaction ID of the commit transaction that initiated the inscription process for multiple inscriptions.
 * @property {string} signedCommitTxHex - The signed transaction hex of the commit transaction, which can be used for broadcasting or record-keeping purposes.
 * @property {string} revealTxId - The transaction ID of the reveal transaction that completed the inscription process for multiple inscriptions.
 * @property {string} signedRevealTxHex - The signed transaction hex of the reveal transaction, which can be used for broadcasting or record-keeping purposes.
 * @property {string[]} inscriptionIds - An array of strings representing the IDs of the inscriptions that were minted in this batch process.
 * @property {number} postage - The amount of postage in satoshis that was included in the inscription transactions, which indicates the cost associated with minting the inscriptions.
 * @property {string} secret - A secret token used during the inscription process, which may be required
 */
export interface InscribeMultipleResult {
  commitTxId: string
  signedCommitTxHex: string
  revealTxId: string
  signedRevealTxHex: string
  inscriptionIds: string[]
  postage: number
  secret: string
}

/**
 * Result of sending an inscription, including the transaction ID of the send transaction, the signed transaction hex, the vout index of the output containing the inscription, and the value of that output in satoshis.
 *
 * @interface SendInscriptionResult
 * @property {string} txId - The transaction ID of the send transaction that transferred the inscription to its new location.
 * @property {string} signedTxHex - The signed transaction hex of the send transaction, which can be used for broadcasting or record-keeping purposes.
 * @property {number} vout - The index of the output in the send transaction that contains the inscription after it has been transferred.
 * @property {number} outputValue - The value of the output containing the inscription in satoshis, which indicates the amount of Bitcoin associated with the inscription after it has been sent.
 */
export interface SendInscriptionResult {
  txId: string
  signedTxHex: string
  vout: number
  outputValue: number
}
