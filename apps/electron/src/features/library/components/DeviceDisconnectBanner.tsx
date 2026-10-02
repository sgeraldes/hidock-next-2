import { AlertCircle, RefreshCw, Usb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BusyIcon } from '@/components/ui/working'

interface DeviceDisconnectBannerProps {
  show: boolean
  isReconnecting: boolean
  onNavigateToDevice: () => void
  onRetry?: () => void
}

export function DeviceDisconnectBanner({
  show,
  isReconnecting,
  onNavigateToDevice,
  onRetry
}: DeviceDisconnectBannerProps) {
  if (!show) return null

  return (
    <div className="flex items-center justify-between gap-4 px-6 py-3 bg-orange-50 dark:bg-orange-950/30 border-b border-orange-200 dark:border-orange-800">
      {isReconnecting ? (
        // Reconnecting is work, not a message: spinner and a short noun, words in the tooltip (owner, 2-oct-2026).
        <div
          className="flex items-center gap-3"
          role="status"
          aria-label="Reconnecting to device"
          title="Reconnecting to device"
        >
          <BusyIcon className="text-orange-600 dark:text-orange-400" />
          <p className="text-sm font-medium text-orange-800 dark:text-orange-200" aria-hidden="true">Device</p>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <AlertCircle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
          <div>
            <p className="text-sm font-medium text-orange-800 dark:text-orange-200">Device disconnected</p>
            <p className="text-xs text-orange-600 dark:text-orange-400">
              Downloads have been paused. Reconnect to continue.
            </p>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        {onRetry && !isReconnecting && (
          <Button variant="outline" size="sm" onClick={onRetry} className="border-orange-300 dark:border-orange-700">
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onNavigateToDevice}
          className="border-orange-300 dark:border-orange-700"
        >
          <Usb className="h-4 w-4 mr-2" />
          Go to Device
        </Button>
      </div>
    </div>
  )
}
