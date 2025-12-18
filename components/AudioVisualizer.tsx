import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  stream: MediaStream | null;
  isMuted: boolean;
  className?: string;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ stream, isMuted, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const audioContextRef = useRef<AudioContext>();
  const analyserRef = useRef<AnalyserNode>();
  const sourceRef = useRef<MediaStreamAudioSourceNode>();

  useEffect(() => {
    if (!stream || isMuted || !canvasRef.current) return;

    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    const ctx = audioContextRef.current;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    analyserRef.current = analyser;

    try {
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        sourceRef.current = source;
    } catch (e) {
        // Can happen if stream is not active or track is ended
        return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const canvas = canvasRef.current;
    const canvasCtx = canvas.getContext('2d');

    const draw = () => {
      if (!canvasCtx) return;
      animationRef.current = requestAnimationFrame(draw);

      analyser.getByteFrequencyData(dataArray);

      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw three rounded bars
      const barCount = 3;
      const spacing = 4;
      const totalWidth = canvas.width;
      const barWidth = (totalWidth - (spacing * (barCount - 1))) / barCount;
      
      // Calculate average volume
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
      const avg = sum / bufferLength;

      // Center color based on volume
      const activeColor = avg > 10 ? '#00D1FF' : '#555';

      for (let i = 0; i < barCount; i++) {
        // Create a wave effect by using different indices
        const value = dataArray[i * 4] / 255; 
        const height = Math.max(4, value * canvas.height * 1.5); // Amplify a bit
        const x = i * (barWidth + spacing);
        const y = (canvas.height - height) / 2;

        canvasCtx.fillStyle = activeColor;
        
        // Draw rounded rect
        canvasCtx.beginPath();
        canvasCtx.roundRect(x, y, barWidth, height, 4);
        canvasCtx.fill();
      }
    };

    draw();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (sourceRef.current) sourceRef.current.disconnect();
      // Do not close AudioContext as it can be reused, or handle properly in full app lifecycle
    };
  }, [stream, isMuted]);

  return (
    <canvas 
        ref={canvasRef} 
        width={24} 
        height={24} 
        className={className} 
    />
  );
};
