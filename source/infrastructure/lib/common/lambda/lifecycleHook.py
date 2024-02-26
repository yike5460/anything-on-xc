import boto3
import json
import os
import logging

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize the S3 client
s3 = boto3.client('s3')

def lambda_handler(event, context):
    """
    {
        "version": "0",
        "id": "12345678-1234-1234-1234-123456789012",
        "detail-type": "EC2 Instance-terminate Lifecycle Action",
        "source": "aws.autoscaling",
        "account": "123456789012",
        "time": "2020-07-22T12:00:00Z",
        "region": "us-west-2",
        "resources": [
            "arn:aws:autoscaling:us-west-2:123456789012:autoScalingGroupName/my-auto-scaling-group:autoScalingGroup:12345678-1234-1234-1234-123456789012:autoScalingGroupName/my-auto-scaling-group"
        ],
        "detail": {
            "LifecycleActionToken": "87654321-4321-4321-4321-210987654321",
            "AutoScalingGroupName": "my-auto-scaling-group",
            "LifecycleHookName": "my-lifecycle-hook",
            "EC2InstanceId": "i-1234567890abcdef0",
            "LifecycleTransition": "autoscaling:EC2_INSTANCE_TERMINATING",
            "NotificationMetadata": "Additional information or metadata"
        }
    }
    """
    # Check if the instance ID is directly available in the event
    instance_id = event.get('detail', {}).get('EC2InstanceId')
    
    # If the instance ID is not in the event, you might need to retrieve it differently
    # This part depends on how the event is structured when directly invoked by the lifecycle hook
    if not instance_id:
        # Placeholder for retrieving the instance ID if not present in the event
        # You may need to modify this part based on the actual event structure
        logger.info("Instance ID not found in the event. Event structure may have changed or is unexpected.")
        return
    
    # Extract the lifecycle action from the event if possible, or set a default
    lifecycle_action = event.get('detail', {}).get('LifecycleTransition', 'UNKNOWN')
    
    # Perform actions based on the lifecycle action
    if lifecycle_action == 'autoscaling:EC2_INSTANCE_TERMINATING':
        # Custom action for instance termination
        handle_termination(instance_id)
    elif lifecycle_action == 'autoscaling:EC2_INSTANCE_LAUNCHING':
        # Custom action for instance launching
        handle_launch(instance_id)
    
    # Send a completion signal back to the ASG if needed
    # Note: This step might not be necessary if the Lambda is directly invoked and the default result is CONTINUE
    # Uncomment and adjust the following code if you need to explicitly complete the lifecycle action
    # asg = boto3.client('autoscaling')
    # asg.complete_lifecycle_action(
    #     LifecycleHookName=event['detail']['LifecycleHookName'],
    #     AutoScalingGroupName=event['detail']['AutoScalingGroupName'],
    #     LifecycleActionResult='CONTINUE',
    #     InstanceId=instance_id
    # )
    
    return {
        'statusCode': 200,
        'body': json.dumps('Lifecycle action processed successfully!')
    }

def handle_termination(instance_id):
    # Example: upload logs from the instance to S3 before termination
    bucket_name = os.environ['BUCKET_NAME']
    logs_path = '/path/to/logs'
    s3_destination = f'logs/{instance_id}/'
    
    # Here you would add the logic to transfer logs from the instance to S3
    # This is a placeholder for the upload process
    # You might need to use Systems Manager Run Command or similar to pull the logs from the instance
    # For example:
    # response = s3.upload_file(logs_path, bucket_name, s3_destination)
    logger.info(f'Logs for {instance_id} would be uploaded to {bucket_name}/{s3_destination}')
    
    # Perform any other cleanup tasks as needed

def handle_launch(instance_id):
    # Example: perform initialization tasks for a new instance
    logger.info(f'Instance {instance_id} is launching. Perform initialization tasks here.')
    
    # Perform any other launch tasks as needed
