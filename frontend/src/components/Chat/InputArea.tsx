/**
 * Input area for sending messages with file attachment support.
 * 
 * Supports:
 * - Drag and drop files
 * - Paste images from clipboard
 * - File picker for documents and images
 * - Image compression for large files
 */

import { useState, useRef, useCallback, KeyboardEvent, DragEvent, ClipboardEvent } from 'react';

// Types for attachments
interface ImageAttachment {
  type: 'image';
  name: string;
  data: string;  // base64
  media_type: string;
  preview: string;  // data URL for preview
}

interface DocumentAttachment {
  type: 'document';
  name: string;
  text: string;  // extracted text
  status: 'extracting' | 'ready' | 'error';
  error?: string;
}

type Attachment = ImageAttachment | DocumentAttachment;

interface InputAreaProps {
  onSend: (content: string, images?: Array<{data: string; media_type: string}>, attachments?: Array<{name: string; text: string}>) => void;
  onCancel: (immediate?: boolean) => void;
  isExecuting: boolean;
  authToken: string;
}

// Supported file types
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];

// Max image size before compression (5MB)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

export function InputArea({ onSend, onCancel, isExecuting, authToken }: InputAreaProps) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Compress image if too large
  const compressImage = useCallback(async (file: File): Promise<{data: string; media_type: string}> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          // If small enough, return as-is
          if (file.size <= MAX_IMAGE_SIZE) {
            const base64 = (e.target?.result as string).split(',')[1];
            resolve({ data: base64, media_type: file.type || 'image/png' });
            return;
          }

          // Compress by reducing dimensions and quality
          const canvas = document.createElement('canvas');
          let { width, height } = img;
          
          // Scale down to max 2000px on longest side
          const maxDim = 2000;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = (height * maxDim) / width;
              width = maxDim;
            } else {
              width = (width * maxDim) / height;
              height = maxDim;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);

          // Convert to JPEG with quality 0.8
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          const base64 = dataUrl.split(',')[1];
          resolve({ data: base64, media_type: 'image/jpeg' });
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = e.target?.result as string;
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  // Extract text from document via backend
  const extractDocument = useCallback(async (file: File): Promise<string> => {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = async (e) => {
        const base64 = (e.target?.result as string).split(',')[1];
        try {
          const response = await fetch('/api/extract', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              filename: file.name,
              content: base64,
            }),
          });
          
          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Extraction failed');
          }
          
          const result = await response.json();
          resolve(result.text);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, [authToken]);

  // Process a file (image or document)
  const processFile = useCallback(async (file: File) => {
    const isImage = IMAGE_TYPES.includes(file.type);
    const isDocument = DOCUMENT_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext));

    if (!isImage && !isDocument) {
      console.warn(`Unsupported file type: ${file.name}`);
      return;
    }

    if (isImage) {
      try {
        const { data, media_type } = await compressImage(file);
        const preview = `data:${media_type};base64,${data}`;
        setAttachments(prev => [...prev, {
          type: 'image',
          name: file.name,
          data,
          media_type,
          preview,
        }]);
      } catch (err) {
        console.error('Failed to process image:', err);
      }
    } else {
      // Add placeholder while extracting
      const placeholderId = Date.now();
      setAttachments(prev => [...prev, {
        type: 'document',
        name: file.name,
        text: '',
        status: 'extracting',
      }]);

      try {
        const text = await extractDocument(file);
        setAttachments(prev => prev.map(a => 
          a.type === 'document' && a.name === file.name && a.status === 'extracting'
            ? { ...a, text, status: 'ready' }
            : a
        ));
      } catch (err) {
        setAttachments(prev => prev.map(a => 
          a.type === 'document' && a.name === file.name && a.status === 'extracting'
            ? { ...a, status: 'error', error: String(err) }
            : a
        ));
      }
    }
  }, [compressImage, extractDocument]);

  // Handle drag events
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    files.forEach(processFile);
  }, [processFile]);

  // Handle paste (for images)
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith('image/'));
    
    if (imageItems.length > 0) {
      e.preventDefault();
      imageItems.forEach(item => {
        const file = item.getAsFile();
        if (file) processFile(file);
      });
    }
  }, [processFile]);

  // Handle file picker
  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach(processFile);
    // Reset input so same file can be selected again
    e.target.value = '';
  }, [processFile]);

  // Remove attachment
  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    const hasContent = trimmed || attachments.length > 0;
    const hasExtractingDocs = attachments.some(a => a.type === 'document' && a.status === 'extracting');
    
    if (hasContent && !isExecuting && !hasExtractingDocs) {
      // Prepare images and document attachments
      const images = attachments
        .filter((a): a is ImageAttachment => a.type === 'image')
        .map(a => ({ data: a.data, media_type: a.media_type }));
      
      const docs = attachments
        .filter((a): a is DocumentAttachment => a.type === 'document' && a.status === 'ready')
        .map(a => ({ name: a.name, text: a.text }));

      onSend(
        trimmed || 'Please analyze the attached content.',
        images.length > 0 ? images : undefined,
        docs.length > 0 ? docs : undefined
      );
      
      setInput('');
      setAttachments([]);

      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  }, [input, attachments, isExecuting, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInput = useCallback(() => {
    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, []);

  const hasExtractingDocs = attachments.some(a => a.type === 'document' && a.status === 'extracting');

  return (
    <div 
      className={`relative ${isDragging ? 'ring-2 ring-amplifier-500 rounded-lg' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-amplifier-500/20 border-2 border-dashed border-amplifier-500 rounded-lg flex items-center justify-center z-10">
          <span className="text-amplifier-400 font-medium">Drop files here</span>
        </div>
      )}

      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 p-2 bg-gray-800/50 rounded-lg">
          {attachments.map((attachment, index) => (
            <div
              key={index}
              className="relative group bg-gray-700 rounded-lg overflow-hidden"
            >
              {attachment.type === 'image' ? (
                <img
                  src={attachment.preview}
                  alt={attachment.name}
                  className="h-16 w-16 object-cover"
                />
              ) : (
                <div className="h-16 w-16 flex flex-col items-center justify-center p-1">
                  <span className="text-2xl">
                    {attachment.status === 'extracting' ? '⏳' : attachment.status === 'error' ? '❌' : '📄'}
                  </span>
                  <span className="text-[10px] text-gray-400 truncate w-full text-center">
                    {attachment.name.split('.').pop()?.toUpperCase()}
                  </span>
                </div>
              )}
              
              {/* Remove button */}
              <button
                onClick={() => removeAttachment(index)}
                className="absolute -top-1 -right-1 w-5 h-5 bg-red-600 rounded-full text-white text-xs
                           opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              >
                ×
              </button>

              {/* Status indicator */}
              {attachment.type === 'document' && attachment.status === 'extracting' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-4 h-4 border-2 border-amplifier-500 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-3">
        {/* File picker button */}
        <button
          onClick={handleFileSelect}
          disabled={isExecuting}
          className="px-3 py-3 text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-lg
                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Attach files (images, PDFs, documents)"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={[...IMAGE_TYPES, ...DOCUMENT_EXTENSIONS.map(e => e)].join(',')}
          onChange={handleFileChange}
          className="hidden"
        />

        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              handleInput();
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isExecuting ? 'Waiting for response...' : 'Type a message... (paste images, drag files)'}
            disabled={isExecuting}
            rows={1}
            className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg resize-none
                       focus:outline-none focus:border-amplifier-500 focus:ring-1 focus:ring-amplifier-500
                       disabled:opacity-50 disabled:cursor-not-allowed
                       placeholder-gray-400 text-gray-100"
          />

          {/* Character count */}
          {input.length > 1000 && (
            <span className="absolute bottom-2 right-2 text-xs text-gray-400">
              {input.length}
            </span>
          )}
        </div>

        {/* Send or Cancel button */}
        {isExecuting ? (
          <button
            onClick={() => onCancel(false)}
            className="px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg
                       transition-colors flex items-center gap-2"
          >
            <span>Cancel</span>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={(!input.trim() && attachments.length === 0) || hasExtractingDocs}
            className="px-4 py-3 bg-amplifier-600 hover:bg-amplifier-700 text-white rounded-lg
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                       flex items-center gap-2"
          >
            <span>Send</span>
            <kbd className="text-xs bg-amplifier-700 px-1.5 py-0.5 rounded">↵</kbd>
          </button>
        )}
      </div>
    </div>
  );
}
